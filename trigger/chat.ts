import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs, type UIMessageChunk } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import postgres from "postgres";
import { createReadOnlyClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";
import { createStore, type Store } from "@shared/store";
import { getAgentLimits, getGuardConfig } from "@shared/env";
import { AGENT_ID } from "./agent-id";
import { checkConversationGuards } from "./guard";
import { ADVISER_V1 } from "./prompts/adviser-v1";
import { buildCatalogTools, type EmitPart } from "./tools";
import { persistAssistantTurn, persistIncomingUserTurns, refusalPart } from "./parts";

// The conversation loop: ONE durable Trigger.dev chat.agent per conversation (keyed on chatId = our
// conversation id). Bedrock runs the eu. Claude sonnet inference profile; the catalog tools are the
// only path to ClickHouse; each data answer streams one `data-insight` part; and every completed
// turn (normal OR stopped) persists the assistant message for resume (AC-13). Guards: the cap/budget
// backstop (below), maxTurns + per-step ceiling from env (AC-17).

export { AGENT_ID };
export const AGENT_LIMITS = getAgentLimits();

// Bedrock via the AWS default credential chain: env vars in the deployed Trigger task (007), the
// local AWS profile in dev. Building the provider does no I/O - creds resolve per request.
const MODEL_ID = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
const model = createAmazonBedrock({
  region: process.env.AWS_REGION ?? "eu-central-1",
  credentialProvider: fromNodeProviderChain(),
})(MODEL_ID);

// Lazy singletons - constructed at turn time (inside the Trigger task's env), never at import, so the
// build passes with no .env.
let analyticsSingleton: Analytics | undefined;
function analytics(): Analytics {
  return (analyticsSingleton ??= createAnalytics({ client: createReadOnlyClient() }));
}

// The tools (and the guard backstop) stream their data parts straight onto the chat response message.
// One typed cast to the SDK's UIMessageChunk union - our parts are structurally data-part chunks, so
// a shape drift (e.g. a bad `type`) is caught here, not silently forwarded.
const emit = (part: EmitPart) => chat.response.write(part as UIMessageChunk);

// A short-lived, single-connection store for one hook (the Trigger task pattern - no module-level
// pool; open, use, close). Used by the guard backstop and the persist hook.
async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return await fn(createStore(sql));
  } finally {
    await sql.end();
  }
}

export const jobChatAgent = chat.agent({
  id: AGENT_ID,
  maxTurns: AGENT_LIMITS.maxTurns,
  tools: () => buildCatalogTools({ analytics: analytics(), emit }),
  run: async ({ chatId, messages, tools, signal }) => {
    // Persist the newly-arrived user turn(s) BEFORE the guard counts them, then apply the backstop -
    // both on ONE connection so the persist-then-count ordering is atomic. Mechanism (a): a follow-up
    // is delivered by the client transport's `sendMessages` (deliver+watch, the only SDK path that
    // streams a freshly-triggered turn live), NOT by the server action, so `run()` is the single
    // persist site (no-op on turn-1 arrival + regenerate; see persistIncomingUserTurns).
    //
    // The hard backstop (AC-15 cap / AC-20 daily budget / input size) on the token's REAL path to
    // Bedrock: the browser holds a write-scoped session token and the standard transport appends
    // follow-ups straight to the inbox, bypassing the server action's early refusal. So the guards -
    // counted via the store, same as the action - MUST also hold here. `persistIncomingUserTurns`
    // refuses an over-length turn ("too_long") before it persists or the model runs; the cap/budget
    // guard then counts the now-persisted turn. Any refusal: stream a taxonomized refusal part (006
    // renders it like an action refusal) and return WITHOUT calling the model, so a guest can never
    // drive Bedrock past the cap/budget or with an unbounded payload.
    const refusal = await withStore(async (store) => {
      const tooLong = await persistIncomingUserTurns(store, chatId, messages);
      if (tooLong) return tooLong;
      return checkConversationGuards({ store, guards: getGuardConfig(), now: () => new Date() }, chatId);
    });
    if (refusal) {
      emit(refusalPart(crypto.randomUUID(), refusal));
      return;
    }
    return streamText({
      ...chat.toStreamTextOptions({ tools }),
      model,
      system: ADVISER_V1,
      messages,
      tools,
      abortSignal: signal,
      stopWhen: stepCountIs(AGENT_LIMITS.maxSteps),
    });
  },
  // Persist the assistant turn on completion. Fires for stopped turns too (responseMessage has its
  // aborted parts cleaned up), which is how a stopped answer's partial card survives to resume -
  // verified live, see the epic decision log (no client-snapshot fallback needed).
  onTurnComplete: async ({ chatId, responseMessage }) => {
    if (!responseMessage) return;
    await withStore((store) => persistAssistantTurn(store, { conversationId: chatId, responseMessage }));
  },
});
