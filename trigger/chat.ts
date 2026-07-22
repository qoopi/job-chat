import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs, type SystemModelMessage, type UIMessageChunk } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import postgres from "postgres";
import { createReadOnlyClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";
import { createStore, type Store } from "@shared/store";
import type { Profile } from "@shared/profile";
import { getAgentLimits, getGuardConfig } from "@shared/env";
import type { CallerKind } from "./guard";
import { AGENT_ID } from "./agent-id";
import { ADVISER_V2 } from "./prompts/adviser-v2";
import { buildCatalogTools, type EmitPart } from "./tools";
import { persistAssistantTurn, hydrateHistory } from "./persistence";
import { createChatRun, type StreamModelArgs } from "./run";

export { AGENT_ID };
export const AGENT_LIMITS = getAgentLimits();

// Bedrock via the AWS default credential chain (env in prod, local profile in dev); building it does no I/O.
const MODEL_ID = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
const model = createAmazonBedrock({
  region: process.env.AWS_REGION ?? "eu-central-1",
  credentialProvider: fromNodeProviderChain(),
})(MODEL_ID);

// Lazy singletons - constructed at turn time, never at import, so the build passes with no .env.
let analyticsSingleton: Analytics | undefined;
function analytics(): Analytics {
  return (analyticsSingleton ??= createAnalytics({ client: createReadOnlyClient() }));
}

const emit = (part: EmitPart) => chat.response.write(part as UIMessageChunk);

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return await fn(createStore(sql));
  } finally {
    await sql.end();
  }
}

type OwnerContext = { callerKind: CallerKind; profile: Profile | null };
const GUEST_CONTEXT: OwnerContext = { callerKind: "guest", profile: null };

// Resolve owner context from an open store. Guests can't own a profile (getProfile skipped); any store
// failure degrades to guest/no-profile rather than failing the turn (logged server-side).
export async function resolveOwnerContext(store: Store, chatId: string): Promise<OwnerContext> {
  try {
    const owner = await store.getConversationOwner(chatId);
    if (!owner) return GUEST_CONTEXT;
    const callerKind: CallerKind = owner.auth_user_id === null ? "guest" : "account";
    if (callerKind === "guest") return { callerKind, profile: null };
    const profile = (await store.getProfile(owner.user_id))?.profile ?? null;
    return { callerKind, profile };
  } catch (err) {
    console.error("[chat] resolveOwnerContext failed - degrading to guest/no-profile", err);
    return GUEST_CONTEXT;
  }
}

// Per-turn owner-context cache keyed by chatId: the SDK gives `tools` then `run` only the chatId, so
// caching here gives both ONE store round-trip. Each turn REPLACES it (fresh resolve, never memoized).
const turnOwnerContext = new Map<string, Promise<OwnerContext>>();
function resolveOwnerContextForTurn(chatId: string): Promise<OwnerContext> {
  const resolved = withStore((store) => resolveOwnerContext(store, chatId)).catch((err) => {
    console.error("[chat] owner-context store unavailable - degrading to guest/no-profile", err);
    return GUEST_CONTEXT;
  });
  turnOwnerContext.set(chatId, resolved);
  return resolved;
}

// Bedrock prompt-cache point so repeat turns read the system block from cache. The systemProviderOptions
// route no-ops here (no chat.prompt.set()); pass the structured SystemModelMessage the SDK emits (ai@7).
const cachePointSystem = (system: string): SystemModelMessage => ({
  role: "system",
  content: system,
  providerOptions: { bedrock: { cachePoint: { type: "default" } } },
});

// Model seam (real path): our system + rebuilt messages win after the toStreamTextOptions spread (no prompt.set()).
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
  coverageProfile: () => analytics().coverageProfile(),
  profile: (chatId) =>
    (turnOwnerContext.get(chatId) ?? resolveOwnerContextForTurn(chatId)).then((c) => c.profile),
  streamModel,
});

// Override the SDK's 16-char generateId with a uuid so the id fits messages.id and keys the idempotent upsert.
export const generateMessageId = (): string => crypto.randomUUID();

export const jobChatAgent = chat.agent({
  id: AGENT_ID,
  maxTurns: AGENT_LIMITS.maxTurns,
  tools: async ({ chatId }) => {
    const { callerKind, profile } = await resolveOwnerContextForTurn(chatId);
    return buildCatalogTools({ analytics: analytics(), emit, callerKind, profile });
  },
  run: (payload) => chatRun(payload),
  uiMessageStreamOptions: { generateMessageId },
  // DB-owned history seam: returning persisted rows makes the SDK skip its snapshot machinery (Postgres is the
  // SOLE history store). This raw return only seeds the SDK accumulator + user count - deliberately uncoalesced.
  hydrateMessages: async ({ chatId, incomingMessages }) =>
    withStore(async (store) =>
      hydrateHistory((await store.getConversation(chatId))?.messages ?? [], incomingMessages),
    ),
  // Persist the assistant turn on completion - normal, stopped, OR errored. An errored turn fires with
  // `error` set; persistAssistantTurn synthesizes the error card so a failed turn reloads with Retry.
  onTurnComplete: async ({ chatId, responseMessage, error }) => {
    turnOwnerContext.delete(chatId); // drop the per-turn owner-context cache (bounds the map)
    await withStore((store) =>
      persistAssistantTurn(store, { conversationId: chatId, responseMessage, error }),
    );
  },
});
