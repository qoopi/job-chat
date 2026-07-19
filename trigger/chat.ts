import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs, type UIMessageChunk } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import postgres from "postgres";
import { createReadOnlyClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";
import { createStore } from "@shared/store";
import { getAgentLimits } from "@shared/env";
import { ADVISER_V1 } from "./prompts/adviser-v1";
import { buildCatalogTools, type EmitPart } from "./tools";
import { persistAssistantTurn } from "./parts";

// The conversation loop: ONE durable Trigger.dev chat.agent per conversation (keyed on chatId = our
// conversation id). Bedrock runs the eu. Claude sonnet inference profile; the catalog tools are the
// only path to ClickHouse; each data answer streams one `data-insight` part; and every completed
// turn (normal OR stopped) persists the assistant message for resume (AC-13). Guards: maxTurns +
// per-step ceiling from env (AC-17).

export const AGENT_ID = "job-chat-agent";
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

// The tools stream their `data-insight` / `data-error` parts straight onto the chat response message.
const emit = (part: EmitPart) => chat.response.write(part as unknown as UIMessageChunk);

export const jobChatAgent = chat.agent({
  id: AGENT_ID,
  maxTurns: AGENT_LIMITS.maxTurns,
  tools: () => buildCatalogTools({ analytics: analytics(), emit }),
  run: async ({ messages, tools, signal }) =>
    streamText({
      ...chat.toStreamTextOptions({ tools }),
      model,
      system: ADVISER_V1,
      messages,
      tools,
      abortSignal: signal,
      stopWhen: stepCountIs(AGENT_LIMITS.maxSteps),
    }),
  // Persist the assistant turn on completion. Fires for stopped turns too (responseMessage has its
  // aborted parts cleaned up), which is how a stopped answer's partial card survives to resume -
  // verified live, see the epic decision log (no client-snapshot fallback needed).
  onTurnComplete: async ({ chatId, responseMessage }) => {
    if (!responseMessage) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await persistAssistantTurn(createStore(sql), { conversationId: chatId, responseMessage });
    } finally {
      await sql.end();
    }
  },
});
