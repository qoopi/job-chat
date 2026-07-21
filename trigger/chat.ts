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
import { ADVISER_V2 } from "./prompts/adviser-v2";
import { buildCatalogTools, type EmitPart } from "./tools";
import { persistAssistantTurn } from "./persistence";
import { createChatRun, type StreamModelArgs } from "./run";

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

// The model seam (real path): stream the rebuilt history to Bedrock. The orchestration - persist the
// incoming turn, apply the cap/budget/size backstop, and REBUILD the model input from the store so the
// model sees the full alternating history (004 round 4) - lives in `createChatRun` (trigger/run.ts),
// with this as the injected model. `chat.toStreamTextOptions` contributes prepareStep (compaction /
// background injection); our explicit system + rebuilt `messages` win after the spread (the app never
// calls `chat.prompt.set()`, so the SDK sets neither).
const streamModel = ({ system, messages, tools, signal }: StreamModelArgs) =>
  streamText({
    ...chat.toStreamTextOptions({ tools }),
    model,
    system,
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
  // The corpus shape for the DATA SCOPE prompt note (018 strand 5), memoized on the analytics singleton
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
  // Persist the assistant turn on completion. Fires for stopped turns too (responseMessage has its
  // aborted parts cleaned up), which is how a stopped answer's partial card survives to resume -
  // verified live, see the epic decision log (no client-snapshot fallback needed).
  onTurnComplete: async ({ chatId, responseMessage }) => {
    if (!responseMessage) return;
    await withStore((store) => persistAssistantTurn(store, { conversationId: chatId, responseMessage }));
  },
});
