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
import { MODEL_ID } from "../../trigger/model-id";
import type { EvalCase } from "./eval-set";
import { createMemoryStore, fakeAnalytics, fakeCoverageProfile } from "./fakes";

// The flag-gated live eval runner. It drives every case's question through the REAL
// prompt + Bedrock model via createChatRun (the same durable-run seam production uses, trigger/run.ts),
// capturing the agent's CHOICES - tool, mode, raw chart pick, params, format - for the scorer. Two seams
// are faked so the ONLY network the run touches is Bedrock: an IN-MEMORY Store and a
// fixture-derived Analytics (see ./fakes). NOT a vitest test (tests/evals/ sits outside the vitest globs);
// run with `JOBCHAT_EVAL=1 bun run eval`.

// Re-exported for run.ts (harness log + transcript name); the model id's one home is trigger/model-id.ts,
// imported by trigger/chat.ts too so the eval never scores a different model than prod.
export { MODEL_ID };

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
  // spends real credits on a full run).
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
  // A data CARD was rendered (=> "data" mode): a valid non-empty insight, OR a postings card, OR a
  // fit-intent invite (auth/profile). A loading skeleton or an empty marker is NOT a card.
  renderedCard: boolean;
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
 * inherits their filters via the rebuilt history); only the LAST turn is scored. The model
 * seam is a DEPENDENCY (not hard-wired to Bedrock) so the replay mechanism is testable offline.
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

  // The identity + profile the case runs under (the profile-driven fit cases). Absent => a guest with
  // no profile. callerKind drives request_profile's card; the profile drives the PROFILE note (run.ts)
  // AND search_postings' server-side merge (the tools). This is the eval's PROFILE-note injection seam.
  const identity = evalCase.identity;
  const callerKind = identity?.signedIn ? "account" : "guest";
  const profile = identity?.profile ?? null;

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
      coverageProfile: fakeCoverageProfile, // inject the DATA SCOPE note, as production does
      profile: async () => profile, // inject the PROFILE note when the case carries a profile
      streamModel,
    });

  let observed: Observed = { toolCalls: [], text: "", renderedCard: false };
  for (let t = 0; t < turns.length; t++) {
    cumulative.push({ role: "user", content: turns[t] });
    const emitted: EmitPart[] = [];
    const emit = (part: EmitPart) => emitted.push(part);
    // The fit tools carry the case's identity + profile, as production's per-turn tools function does.
    const tools = buildCatalogTools({ analytics: fakeAnalytics(), emit, callerKind, profile });
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
          renderedCard: false,
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
      const renderedCard = emitted.some(
        (p) =>
          (p.type === "data-insight" &&
            DataInsightSchema.safeParse((p as { data: unknown }).data).success) ||
          p.type === "data-postings" ||
          p.type === "data-auth-invite" ||
          p.type === "data-profile-invite",
      );
      observed = { toolCalls, text, renderedCard };
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
        renderedCard: false,
        error: (err as Error).message,
      };
      break;
    }
  }
  return observed;
}
