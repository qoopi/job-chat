import { streamText, stepCountIs } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { DataInsightSchema } from "@shared/insight";
import { getAgentLimits } from "@shared/env";
import {
  createChatRun,
  type StreamModel,
  type StreamModelArgs,
} from "../../trigger/run";
import { buildCatalogTools, type EmitPart } from "../../trigger/tools";
import { persistAssistantTurn } from "../../trigger/persistence";
import type { EvalCase } from "./eval-set";
import { createMemoryStore, fakeAnalytics, fakeCoverageProfile } from "./fakes";

// The flag-gated live eval runner (AC-6/AC-7/AC-4). It drives every case's question through the REAL
// prompt + Bedrock model via createChatRun (the same durable-run seam production uses, trigger/run.ts),
// capturing the agent's CHOICES - tool, mode, raw chart pick, params, format - for the scorer. Two seams
// are faked per the epic ruling so the ONLY network the run touches is Bedrock: an IN-MEMORY Store and a
// fixture-derived Analytics (see ./fakes). NOT a vitest test (tests/evals/ sits outside the vitest globs);
// run with `JOBCHAT_EVAL=1 bun run eval`.

// The shipped model - kept in step with trigger/chat.ts (the production seam). Redefined here rather than
// imported because importing trigger/chat.ts would register the chat.agent() task outside the Trigger
// runtime; this string is the only coupling. DRIFT RISK: if chat.ts's MODEL_ID changes and this does not,
// the eval silently scores a DIFFERENT model than prod and the gate loses meaning (backlog:
// eval-model-id-shared-const - a shared leaf-module const both import, a product-code change out of scope).
export const MODEL_ID = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";

export function buildModel() {
  return createAmazonBedrock({
    region: process.env.AWS_REGION ?? "eu-central-1",
    credentialProvider: fromNodeProviderChain(),
  })(MODEL_ID);
}
type EvalModel = ReturnType<typeof buildModel>;

// ---- guards + args ------------------------------------------------------------------------------

/**
 * Hard-refuse unless JOBCHAT_EVAL=1 AND Bedrock credentials are present. The flag is checked FIRST (the
 * offline smoke asserts exactly this), then the credential source the model's default chain needs
 * (AWS_REGION plus either static keys or a named profile). Throws with a plain, actionable message;
 * NOTHING runs before this passes, so no Bedrock call is ever made by accident.
 */
export function assertEvalEnabled(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.JOBCHAT_EVAL !== "1") {
    throw new Error(
      "refusing to run: this harness makes live Bedrock calls (cost). Set JOBCHAT_EVAL=1 to enable.",
    );
  }
  // CAUTION: Bun auto-loads Job.Chat/.env into child processes, so `env -u AWS_REGION ...` (or any shell
  // cred-stripping) CANNOT prove this missing-creds refusal live - .env repopulates AWS_* before the guard
  // runs. This branch is covered offline (tests/unit/eval-harness.test.ts); do NOT re-probe it live (it
  // spends real credits on a full run - see the 010 Test Report credits incident).
  const hasKeys = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  const hasProfile = Boolean(env.AWS_PROFILE);
  if (!env.AWS_REGION || (!hasKeys && !hasProfile)) {
    throw new Error(
      "refusing to run: missing Bedrock env (need AWS_REGION and either AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY or AWS_PROFILE).",
    );
  }
}

/**
 * The optional JOBCHAT_EVAL_IDS subset filter: a comma-separated list of case ids restricts the run to
 * exactly those cases (the spot-check the env name always promised). An empty/unset value runs the full
 * set. Returns the selected cases plus the number skipped so the runner can log it - no silent caps. Ids
 * that match nothing simply contribute to the skipped count (an empty selection is a valid, explicit ask).
 */
export function selectEvalCases(
  evalSet: readonly EvalCase[],
  rawIds: string | undefined,
): { cases: EvalCase[]; skipped: number } {
  const wanted = new Set(
    (rawIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return { cases: [...evalSet], skipped: 0 };
  const cases = evalSet.filter((c) => wanted.has(c.id));
  return { cases, skipped: evalSet.length - cases.length };
}

// ---- drive one case -----------------------------------------------------------------------------

export interface Observed {
  toolCalls: { name: string; input: Record<string, unknown> }[];
  text: string;
  hasInsight: boolean; // a valid, non-empty insight card was emitted (=> "data" mode)
  error?: string;
}

/**
 * The streamed-result shape `runCase` consumes - a SUBSET of streamText's result (consumeStream to drive
 * tool execution, steps for the tool calls, text for the answer). The live Bedrock seam returns a full
 * streamText result (a superset); an offline test's fake model returns exactly this shape.
 */
export interface EvalStreamResult {
  consumeStream(): PromiseLike<unknown>;
  steps: PromiseLike<{ toolCalls: { toolName: string; input?: unknown }[] }[]>;
  text: PromiseLike<string>;
}

/** The injectable model seam `runCase` drives: real = Bedrock via streamText; offline test = a fake. */
export type EvalStreamModel = StreamModel<EvalStreamResult>;

/**
 * The live Bedrock model seam: streamText bound to the model and the agent's step cap. Built ONCE in
 * `main` and threaded into `runCase`, so the context-turn replay loop can be driven by a fake model
 * offline (no Bedrock) - it mirrors trigger/chat.ts minus the Trigger-runtime plumbing.
 */
export function bedrockStreamModel(model: EvalModel): EvalStreamModel {
  const limits = getAgentLimits();
  return ({ system, messages, tools, signal }: StreamModelArgs) =>
    streamText({
      model,
      system,
      messages,
      tools,
      abortSignal: signal,
      stopWhen: stepCountIs(limits.maxSteps),
    });
}

/**
 * Drive a case through createChatRun with the injected model seam, capturing tool calls, text, and parts.
 * A case with `context` runs those prior user turns first (persisting each answer so the scored follow-up
 * inherits their filters via the rebuilt history, 018 strand 4); only the LAST turn is scored. The model
 * seam is a DEPENDENCY (not hard-wired to Bedrock) so the replay mechanism is testable offline (018
 * review-fix R2).
 */
export async function runCase(
  streamModel: EvalStreamModel,
  system: string,
  evalCase: EvalCase,
): Promise<Observed> {
  const store = createMemoryStore();
  const guestId = `eval-${crypto.randomUUID()}`;
  await store.getOrCreateUser(guestId);
  const turns = [...(evalCase.context ?? []), evalCase.question];
  const conv = await store.createConversation(guestId, turns[0]);
  await store.appendMessage(conv.id, "user", turns[0], null); // mirror startConversation (turn 1)
  const cumulative: { role: "user"; content: string }[] = [];

  const buildRun = (emit: (part: EmitPart) => void) =>
    createChatRun({
      withStore: (fn) => fn(store),
      // Generous caps: the eval is not testing the guard, so no case is ever refused before the model.
      guards: {
        guestCap: Number.MAX_SAFE_INTEGER,
        dailyBudget: Number.MAX_SAFE_INTEGER,
      },
      emit,
      now: () => new Date(),
      system,
      coverageProfile: fakeCoverageProfile, // 018 strand 5: inject the DATA SCOPE note, as production does
      streamModel,
    });

  let observed: Observed = { toolCalls: [], text: "", hasInsight: false };
  for (let t = 0; t < turns.length; t++) {
    cumulative.push({ role: "user", content: turns[t] });
    const emitted: EmitPart[] = [];
    const emit = (part: EmitPart) => emitted.push(part);
    const tools = buildCatalogTools({ analytics: fakeAnalytics(), emit });
    try {
      const result = await buildRun(emit)({
        chatId: conv.id,
        trigger: "submit-message",
        messages: cumulative.map((m) => ({ ...m })),
        tools,
        signal: new AbortController().signal,
      });
      if (!result) {
        observed = {
          toolCalls: [],
          text: "",
          hasInsight: false,
          error: "run refused before the model (unexpected)",
        };
        break;
      }
      await result.consumeStream(); // drive tool execution + finish
      const steps = await result.steps;
      const toolCalls = steps
        .flatMap((s) => s.toolCalls)
        .map((tc) => ({
          name: tc.toolName,
          input: (tc.input ?? {}) as Record<string, unknown>,
        }));
      const text = (await result.text).trim();
      const hasInsight = emitted.some(
        (p) =>
          p.type === "data-insight" &&
          DataInsightSchema.safeParse((p as { data: unknown }).data).success,
      );
      observed = { toolCalls, text, hasInsight };
      // Persist the assistant turn (mirror onTurnComplete) so a later turn's rebuilt history carries it.
      const responseMessage = {
        parts: [
          { type: "text", text },
          ...emitted.map((p) => ({
            type: p.type,
            id: p.id,
            data: (p as { data: unknown }).data,
          })),
        ],
      };
      await persistAssistantTurn(store, {
        conversationId: conv.id,
        responseMessage,
      });
    } catch (err) {
      observed = {
        toolCalls: [],
        text: "",
        hasInsight: false,
        error: (err as Error).message,
      };
      break;
    }
  }
  return observed;
}
