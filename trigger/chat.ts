import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs, type SystemModelMessage, type UIMessageChunk } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import postgres from "postgres";
import { createReadOnlyClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";
import { createStore, type Store } from "@shared/store";
import { getAgentLimits, getGuardConfig } from "@shared/env";
import { AGENT_ID } from "./agent-id";
import { ADVISER_V2 } from "./prompts/adviser-v2";
import { buildCatalogTools, type EmitPart } from "./tools";
import { persistAssistantTurn, hydrateHistory } from "./persistence";
import { createChatRun, type StreamModelArgs } from "./run";

// The conversation loop: ONE durable Trigger.dev chat.agent per conversation (keyed on chatId = our
// conversation id). Bedrock runs the eu. Claude sonnet inference profile; the catalog tools are the
// only path to ClickHouse; each data answer streams one `data-insight` part; and every completed
// turn (normal OR stopped) persists the assistant message for resume. Guards: the cap/budget
// backstop (below), maxTurns + per-step ceiling from env.

export { AGENT_ID };
export const AGENT_LIMITS = getAgentLimits();

// Bedrock via the AWS default credential chain: env vars in the deployed Trigger task, the
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

// Mark the system block as a Bedrock prompt-cache point so repeat turns read it from cache (no
// behavior change). The toStreamTextOptions `systemProviderOptions` route
// silently no-ops here (the SDK builds a system block only after chat.prompt.set(), which we never
// call, and our explicit `system:` after the spread overrides it anyway). Instead pass the structured
// SystemModelMessage directly - the exact shape the SDK itself emits for a provider cache point (ai@7
// `Instructions` accepts a SystemModelMessage).
const cachePointSystem = (system: string): SystemModelMessage => ({
  role: "system",
  content: system,
  providerOptions: { bedrock: { cachePoint: { type: "default" } } },
});

// The model seam (real path): stream the rebuilt history to Bedrock. The orchestration - persist the
// incoming turn, apply the cap/budget/size backstop, and REBUILD the model input from the store so the
// model sees the full alternating history - lives in `createChatRun` (trigger/run.ts),
// with this as the injected model. `chat.toStreamTextOptions` contributes prepareStep (compaction /
// background injection); our structured system + rebuilt `messages` win after the spread (the app never
// calls `chat.prompt.set()`, so the SDK sets neither).
export const streamModel = ({ system, messages, tools, signal }: StreamModelArgs) =>
  streamText({
    ...chat.toStreamTextOptions({ tools }),
    model,
    system: cachePointSystem(system),
    messages,
    tools,
    abortSignal: signal,
    stopWhen: stepCountIs(AGENT_LIMITS.maxSteps),
  });

const chatRun = createChatRun({
  withStore,
  guards: getGuardConfig(),
  emit,
  now: () => new Date(),
  system: ADVISER_V2,
  // The corpus shape for the DATA SCOPE prompt note, memoized on the analytics singleton
  // so it costs one ClickHouse query per process, not per turn.
  coverageProfile: () => analytics().coverageProfile(),
  streamModel,
});

// The response message's id, minted once per assistant turn. The AI SDK defaults to a 16-char
// generateId; we override to a uuid so the id fits the messages.id uuid column AND lets the assistant
// row be persisted keyed by it (idempotent upsert), with no column migration.
export const generateMessageId = (): string => crypto.randomUUID();

export const jobChatAgent = chat.agent({
  id: AGENT_ID,
  maxTurns: AGENT_LIMITS.maxTurns,
  tools: () => buildCatalogTools({ analytics: analytics(), emit }),
  run: (payload) => chatRun(payload),
  // Mint uuid response ids so responseMessage.id is a uuid the store can key the assistant row on.
  uiMessageStreamOptions: { generateMessageId },
  // Register the DB-owned history seam. Returning the persisted rows (raw, via hydrateHistory)
  // makes the SDK skip its snapshot machinery entirely ("customers own persistence") - Postgres is the
  // SOLE history store, deleting the parallel snapshot reads/writes and one class of redelivery source.
  // createChatRun still owns the MODEL-input rebuild (buildModelHistory over the store), so this raw
  // return only seeds the SDK accumulator and the user count persistIncomingUserTurns reads - which is why
  // it is deliberately uncoalesced (see hydrateHistory).
  hydrateMessages: async ({ chatId, incomingMessages }) =>
    withStore(async (store) =>
      hydrateHistory((await store.getConversation(chatId))?.messages ?? [], incomingMessages),
    ),
  // Persist the assistant turn on completion - normal, stopped, OR errored. A stopped turn carries a
  // responseMessage with its aborted parts cleaned up (a partial card survives to resume). An ERRORED
  // turn fires with `error` set and the response undefined-or-partial; persistAssistantTurn synthesizes
  // the error card so a failed turn persists as a turn and reloads with Retry.
  onTurnComplete: async ({ chatId, responseMessage, error }) => {
    await withStore((store) =>
      persistAssistantTurn(store, { conversationId: chatId, responseMessage, error }),
    );
  },
});
