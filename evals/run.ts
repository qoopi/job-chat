import { streamText, stepCountIs } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { Analytics, CoverageProfile, QueryResult } from "@shared/analytics";
import { DataInsightSchema } from "@shared/insight";
import {
  deriveTitle,
  type Conversation,
  type Json,
  type Message,
  type MessageRole,
  type Store,
  type User,
} from "@shared/store";
import { getAgentLimits } from "@shared/env";
import { createChatRun, type StreamModelArgs } from "../trigger/run";
import { buildCatalogTools, CATALOG_TOOL_NAMES, type EmitPart } from "../trigger/tools";
import { persistAssistantTurn } from "../trigger/parts";
import { ADVISER_V1 } from "../trigger/prompts/adviser-v1";
import { ADVISER_V2 } from "../trigger/prompts/adviser-v2";
import { FIXTURE_INGESTED_AT } from "../tests/fixtures/postings.fixture";
import { countSentences, startsWithBannedOpener } from "../tests/fixtures/plain-prompts";
import { CHART_BEARING, EVAL_SET, type EvalCase, type EvalExpect, type EvalMode } from "./eval-set";

// The flag-gated live eval runner (AC-6/AC-7/AC-4). It drives every case's question through the REAL
// prompt + Bedrock model via createChatRun (the same durable-run seam production uses, trigger/run.ts),
// scores the agent's CHOICES - tool, mode, raw chart pick, params, format - and prints a per-case +
// aggregate report. Two seams are faked per the epic ruling so the ONLY network the run touches is
// Bedrock: an IN-MEMORY Store (createChatRun rebuilds history from + persists to its Store; no real
// Postgres) and a fixture-derived Analytics (the tools' only path to data; no real ClickHouse - scoring
// judges the agent's choices, not the numbers). Cost: ~one agent turn per case, on-demand only; guarded
// by JOBCHAT_EVAL=1 so it can never run in CI or by accident. NOT a vitest test (evals/ sits outside the
// vitest globs); run with `JOBCHAT_EVAL=1 bun run eval --prompt v1|v2`.

// The shipped model - kept in step with trigger/chat.ts (the production seam). Redefined here rather than
// imported because importing trigger/chat.ts would register the chat.agent() task outside the Trigger
// runtime; this string is the only coupling. DRIFT RISK: if chat.ts's MODEL_ID changes and this does not,
// the eval silently scores a DIFFERENT model than prod and the gate loses meaning (backlog:
// eval-model-id-shared-const - a shared leaf-module const both import, a product-code change out of scope).
const MODEL_ID = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";

function buildModel() {
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
export function assertEvalEnabled(env: Record<string, string | undefined> = process.env): void {
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

export type PromptVersion = "v1" | "v2";

export function parsePrompt(argv: string[]): PromptVersion {
  const i = argv.indexOf("--prompt");
  const value = i >= 0 ? argv[i + 1] : "v2";
  if (value !== "v1" && value !== "v2") {
    throw new Error(`--prompt must be "v1" or "v2" (got: ${String(value)})`);
  }
  return value;
}

// ---- faked seams (no real Postgres, no real ClickHouse) -----------------------------------------

/**
 * The in-memory Store the epic ruling calls for: createChatRun persists incoming user turns, counts them
 * for the guard, and rebuilds the model history from its Store - all absorbed in memory here. Only the
 * run-path methods carry real behaviour; the auth/history methods (unused by the run) are minimal.
 */
function createMemoryStore(): Store {
  const users = new Map<string, User>();
  const conversations = new Map<string, Conversation>();
  const messages: Message[] = []; // insertion order == chronological (getConversation preserves it)
  const now = () => new Date();

  return {
    async getOrCreateUser(guestId: string) {
      const existing = users.get(guestId);
      if (existing) return existing;
      const user: User = { user_id: guestId, created_at: now(), auth_user_id: null };
      users.set(guestId, user);
      return user;
    },
    async createConversation(userId: string, firstQuestion: string) {
      const conv: Conversation = {
        id: crypto.randomUUID(),
        user_id: userId,
        title: deriveTitle(firstQuestion),
        created_at: now(),
      };
      conversations.set(conv.id, conv);
      return conv;
    },
    async appendMessage(conversationId: string, role: MessageRole, content: string, parts: Json | null) {
      const message: Message = {
        id: crypto.randomUUID(),
        conversation_id: conversationId,
        role,
        content,
        parts: parts ?? null,
        created_at: now(),
      };
      messages.push(message);
      return message;
    },
    async getConversation(conversationId: string) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return null;
      return {
        conversation,
        messages: messages.filter((m) => m.conversation_id === conversationId),
      };
    },
    async getConversationOwner(conversationId: string) {
      const conv = conversations.get(conversationId);
      if (!conv) return null;
      return { user_id: conv.user_id, auth_user_id: users.get(conv.user_id)?.auth_user_id ?? null };
    },
    async findUserByAuthId(authUserId: string) {
      for (const user of users.values()) if (user.auth_user_id === authUserId) return user;
      return null;
    },
    async linkAuthUser() {
      return false; // unused by the eval run path
    },
    async adoptGuest() {
      // unused by the eval run path
    },
    async deleteConversation() {
      // unused by the eval run path
    },
    async listConversations(userId: string) {
      return [...conversations.values()]
        .filter((c) => c.user_id === userId)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map(({ id, title, created_at }) => ({ id, title, created_at }));
    },
    async messageCounts({ userId, sinceUtcMidnight }: { userId?: string; sinceUtcMidnight: Date }) {
      return messages.filter(
        (m) =>
          m.role === "user" &&
          m.created_at >= sinceUtcMidnight &&
          (userId === undefined || conversations.get(m.conversation_id)?.user_id === userId),
      ).length;
    },
  };
}

/**
 * A fixture-derived Analytics: every query returns the SAME small, schema-valid QueryResult built from
 * the reference dataset's domain values (tests/fixtures/postings.fixture.ts). It never executes a query
 * or computes a real aggregate - the harness scores the agent's CHOICES, not the data (epic no-real-CH
 * ruling). The rows carry a superset of the columns any verdict/insight reads, so buildInsight /
 * buildComposedInsight always produce a valid, non-empty card (=> the run registers "data" mode).
 */
function fakeAnalytics(): Analytics {
  const rows: Record<string, unknown>[] = [
    { label: "Google", company: "Google", city: "San Francisco", region: "California", country: "United States", title: "Senior Software Engineer", experience_level: "Senior", employment_type: "full-time", location_kind: "onsite", bucket: "2026-05-01", day: "2026-05-01", count: 4, median: 180000, median_salary: 180000, p25_salary: 150000, p75_salary: 200000, n: 4 },
    { label: "Meta", company: "Meta", city: "Los Angeles", region: "California", country: "United States", title: "Backend Engineer", experience_level: "Senior", employment_type: "full-time", location_kind: "hybrid", bucket: "2026-06-01", day: "2026-06-01", count: 2, median: 150000, median_salary: 150000, p25_salary: 130000, p75_salary: 170000, n: 2 },
    { label: "Stripe", company: "Stripe", city: "San Francisco", region: "California", country: "United States", title: "Data Engineer", experience_level: "Junior", employment_type: "contract", location_kind: "remote", bucket: "2026-07-01", day: "2026-07-01", count: 2, median: 170000, median_salary: 170000, p25_salary: 140000, p75_salary: 190000, n: 2 },
  ];
  const result = (sql: string): QueryResult => ({ sql, rows, meta: { sampleN: 8, freshestAt: FIXTURE_INGESTED_AT } });
  return {
    runQuery: async (name) => result(`-- fake template ${name}`),
    runComposedQuery: async () => result(`-- fake query_postings`),
    coverageProfile: fakeCoverageProfile,
  };
}

/**
 * The corpus shape the eval injects into the system prompt (018 strand 5), matching the live ground
 * truth so a market-wide question exercises the SAME DATA SCOPE note production ships (mostly Google).
 */
function fakeCoverageProfile(): Promise<CoverageProfile> {
  return Promise.resolve({
    total: 3488,
    distinctCompanies: 7,
    topCompany: "Google",
    topCompanyShare: 0.93,
    freshestAt: FIXTURE_INGESTED_AT,
    salaryCoverage: 0.65,
  });
}

// ---- drive one case -----------------------------------------------------------------------------

export interface Observed {
  toolCalls: { name: string; input: Record<string, unknown> }[];
  text: string;
  hasInsight: boolean; // a valid, non-empty insight card was emitted (=> "data" mode)
  error?: string;
}

/**
 * Drive a case through createChatRun with the real model, capturing tool calls, text, and parts. A case
 * with `context` runs those prior user turns first (persisting each answer so the scored follow-up
 * inherits their filters via the rebuilt history, 018 strand 4); only the LAST turn is scored.
 */
async function runCase(model: EvalModel, system: string, evalCase: EvalCase): Promise<Observed> {
  const store = createMemoryStore();
  const guestId = `eval-${crypto.randomUUID()}`;
  await store.getOrCreateUser(guestId);
  const turns = [...(evalCase.context ?? []), evalCase.question];
  const conv = await store.createConversation(guestId, turns[0]);
  await store.appendMessage(conv.id, "user", turns[0], null); // mirror startConversation (turn 1)
  const limits = getAgentLimits();
  const cumulative: { role: "user"; content: string }[] = [];

  const buildRun = (emit: (part: EmitPart) => void) =>
    createChatRun({
      withStore: (fn) => fn(store),
      // Generous caps: the eval is not testing the guard, so no case is ever refused before the model.
      guards: { guestCap: Number.MAX_SAFE_INTEGER, dailyBudget: Number.MAX_SAFE_INTEGER },
      emit,
      now: () => new Date(),
      system,
      coverageProfile: fakeCoverageProfile, // 018 strand 5: inject the DATA SCOPE note, as production does
      // The model seam, mirroring trigger/chat.ts minus the Trigger-runtime plumbing.
      streamModel: ({ system: sys, messages, tools: turnTools, signal }: StreamModelArgs) =>
        streamText({
          model,
          system: sys,
          messages,
          tools: turnTools,
          abortSignal: signal,
          stopWhen: stepCountIs(limits.maxSteps),
        }),
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
        messages: cumulative.map((m) => ({ ...m })),
        tools,
        signal: new AbortController().signal,
      });
      if (!result) {
        observed = { toolCalls: [], text: "", hasInsight: false, error: "run refused before the model (unexpected)" };
        break;
      }
      await result.consumeStream(); // drive tool execution + finish
      const steps = await result.steps;
      const toolCalls = steps
        .flatMap((s) => s.toolCalls)
        .map((tc) => ({ name: tc.toolName, input: (tc.input ?? {}) as Record<string, unknown> }));
      const text = (await result.text).trim();
      const hasInsight = emitted.some(
        (p) => p.type === "data-insight" && DataInsightSchema.safeParse((p as { data: unknown }).data).success,
      );
      observed = { toolCalls, text, hasInsight };
      // Persist the assistant turn (mirror onTurnComplete) so a later turn's rebuilt history carries it.
      const responseMessage = {
        parts: [
          { type: "text", text },
          ...emitted.map((p) => ({ type: p.type, id: p.id, data: (p as { data: unknown }).data })),
        ],
      };
      await persistAssistantTurn(store, { conversationId: conv.id, responseMessage });
    } catch (err) {
      observed = { toolCalls: [], text: "", hasInsight: false, error: (err as Error).message };
      break;
    }
  }
  return observed;
}

// ---- scoring (pure, deterministic) --------------------------------------------------------------

export interface ScoredCase {
  id: string;
  observedMode: EvalMode;
  observedTools: string[];
  rawChartType?: string;
  toolPass: boolean;
  modePass: boolean;
  toolModePass: boolean; // the AC-7 unit
  chartBearing: boolean;
  chartPass?: boolean; // chart-bearing cases only (AC-4)
  paramsChecked: boolean;
  paramsPass?: boolean;
  formatChecked: boolean;
  formatPass?: boolean;
  scopeChecked: boolean;
  scopePass?: boolean;
  error?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function sameSet(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
  const bn = b.map(norm);
  return a.every((x) => bn.includes(norm(x)));
}

/** SUBSET match: every expected key present in the actual input with an equal value (never exact-object). */
function paramsSubsetMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, exp]) => {
    const act = actual[key];
    if (Array.isArray(exp)) return Array.isArray(act) && sameSet(exp, act);
    if (typeof exp === "string" && typeof act === "string") return exp.toLowerCase() === act.toLowerCase();
    return act === exp;
  });
}

// The data tools whose call renders an insight card: the 6 fixed templates + the composed query_postings.
// A second data tool means a second card - a defect under P1's "one answer, one card" contract - so a
// data-tool expectation must be met by EXACTLY that tool, called once, with no other data tool alongside.
const DATA_TOOLS = new Set<string>([...CATALOG_TOOL_NAMES, "query_postings"]);

// AC-7 asks the agent to "select THE expected tool and mode" (definite article, singular). For a data tool
// that means the expected tool called EXACTLY once and NO other data tool: a right tool called beside an
// extra data tool emits a second card - a defect, not a pass (the saved v1 Q5 hit this: share_split +
// query_postings). The pure-plain (no-tool) and report_unanswerable cases are excepted - plain expects
// zero tools, and report_unanswerable (not a data tool) keeps the lenient membership check as before.
function toolMatches(expect: EvalExpect, observedTools: string[]): boolean {
  if (expect.tool === undefined) return observedTools.length === 0; // a pure plain answer calls no tool
  if (!DATA_TOOLS.has(expect.tool)) return observedTools.includes(expect.tool); // report_unanswerable
  const expectedCalls = observedTools.filter((t) => t === expect.tool).length;
  const extraDataTool = observedTools.some((t) => t !== expect.tool && DATA_TOOLS.has(t));
  return expectedCalls === 1 && !extraDataTool;
}

function formatOk(text: string): boolean {
  return countSentences(text) <= 2 && !text.includes("!") && !startsWithBannedOpener(text);
}

// 018 strand 5 (informational): a scope-qualified answer names the sample / its dominance rather than
// presenting the corpus as the whole market. Heuristic over the answer text - never gates a run.
function scopeQualifiedOk(text: string): boolean {
  return /\bsample\b|\bmostly\b|\bgoogle\b|\balphabet\b|dominat|one (company|employer)|not.*(representative|whole|entire|full)/i.test(
    text,
  );
}

export function scoreCase(evalCase: EvalCase, observed: Observed): ScoredCase {
  const { expect } = evalCase;
  const observedTools = observed.toolCalls.map((t) => t.name);
  const observedMode: EvalMode = observed.hasInsight ? "data" : "plain";
  const modePass = observedMode === expect.mode;
  const toolPass = toolMatches(expect, observedTools);

  const composedCall = observed.toolCalls.find((t) => t.name === "query_postings");
  const rawChartType = composedCall ? asString(composedCall.input.chartType) : undefined;
  const chartBearing = expect.chartType !== undefined;

  const expectedCall = expect.tool ? observed.toolCalls.find((t) => t.name === expect.tool) : undefined;
  const paramsChecked = Boolean(expect.params && expectedCall);

  return {
    id: evalCase.id,
    observedMode,
    observedTools,
    rawChartType,
    toolPass,
    modePass,
    toolModePass: toolPass && modePass,
    chartBearing,
    chartPass: chartBearing ? rawChartType === expect.chartType : undefined,
    paramsChecked,
    paramsPass: paramsChecked ? paramsSubsetMatch(expect.params!, expectedCall!.input) : undefined,
    formatChecked: Boolean(expect.formatRules),
    formatPass: expect.formatRules ? formatOk(observed.text) : undefined,
    scopeChecked: Boolean(expect.scopeQualified),
    scopePass: expect.scopeQualified ? scopeQualifiedOk(observed.text) : undefined,
    error: observed.error,
  };
}

// ---- aggregate + gates --------------------------------------------------------------------------

const GATE = 0.9;

export interface Aggregate {
  total: number;
  toolModePass: number;
  toolPass: number;
  modePass: number;
  chartTotal: number;
  chartPass: number;
  paramsTotal: number;
  paramsPass: number;
  formatTotal: number;
  formatPass: number;
  scopeTotal: number;
  scopePass: number;
  errors: number;
}

export function aggregate(scored: ScoredCase[]): Aggregate {
  const count = (pred: (s: ScoredCase) => boolean) => scored.filter(pred).length;
  return {
    total: scored.length,
    toolModePass: count((s) => s.toolModePass),
    toolPass: count((s) => s.toolPass),
    modePass: count((s) => s.modePass),
    chartTotal: count((s) => s.chartBearing),
    chartPass: count((s) => s.chartBearing && s.chartPass === true),
    paramsTotal: count((s) => s.paramsChecked),
    paramsPass: count((s) => s.paramsPass === true),
    formatTotal: count((s) => s.formatChecked),
    formatPass: count((s) => s.formatPass === true),
    scopeTotal: count((s) => s.scopeChecked),
    scopePass: count((s) => s.scopePass === true),
    errors: count((s) => s.error !== undefined),
  };
}

// ---- reporting (deterministic: fixed order, no timestamps) ---------------------------------------

const RULE = "-".repeat(96);
const HEAVY = "=".repeat(96);
const flag = (v: boolean | undefined) => (v === undefined ? "--" : v ? "ok" : "XX");
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function printCase(index: number, evalCase: EvalCase, s: ScoredCase): void {
  const idx = String(index).padStart(2, "0");
  const headline = s.toolModePass ? "PASS" : "FAIL";
  const chartCol = s.chartBearing ? ` chart=${flag(s.chartPass)}` : "";
  console.log(
    `[${idx}] ${evalCase.id.padEnd(4)} ${headline}  tool=${flag(s.toolPass)} mode=${flag(s.modePass)}${chartCol}  "${truncate(evalCase.question, 62)}"`,
  );
  const expBits = [
    `mode=${evalCase.expect.mode}`,
    `tool=${evalCase.expect.tool ?? "(none)"}`,
    evalCase.expect.chartType ? `chart=${evalCase.expect.chartType}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const actBits = [
    `mode=${s.observedMode}`,
    `tools=[${s.observedTools.join(",") || "(none)"}]`,
    s.rawChartType ? `chart=${s.rawChartType}` : "",
    `params=${flag(s.paramsPass)}`,
    `format=${flag(s.formatPass)}`,
    s.error ? `ERROR=${truncate(s.error, 60)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(`        exp: ${expBits}`);
  console.log(`        act: ${actBits}`);
}

function printReport(prompt: PromptVersion, scored: ScoredCase[]): void {
  const agg = aggregate(scored);
  const ac7 = agg.toolModePass / agg.total >= GATE;
  const ac4 = agg.chartTotal > 0 && agg.chartPass / agg.chartTotal >= GATE;

  console.log(RULE);
  console.log(`AGGREGATE (prompt ${prompt})`);
  console.log(
    `  tool+mode : ${agg.toolModePass}/${agg.total}  (${pct(agg.toolModePass, agg.total)})   AC-7 gate >= 90% : ${ac7 ? "PASS" : "FAIL"}`,
  );
  console.log(`    - tool  : ${agg.toolPass}/${agg.total}  (${pct(agg.toolPass, agg.total)})`);
  console.log(`    - mode  : ${agg.modePass}/${agg.total}  (${pct(agg.modePass, agg.total)})`);
  console.log(
    `  chart-pick: ${agg.chartPass}/${agg.chartTotal}  (${pct(agg.chartPass, agg.chartTotal)})   AC-4 gate >= 90% : ${ac4 ? "PASS" : "FAIL"}   (chart-bearing cases only)`,
  );
  console.log(`  params    : ${agg.paramsPass}/${agg.paramsTotal}  (${pct(agg.paramsPass, agg.paramsTotal)})   (informational; subset match on the expected tool call)`);
  console.log(`  format    : ${agg.formatPass}/${agg.formatTotal}  (${pct(agg.formatPass, agg.formatTotal)})   (informational; AC-5 tone gate is the offline vitest test)`);
  console.log(`  scope     : ${agg.scopePass}/${agg.scopeTotal}  (${pct(agg.scopePass, agg.scopeTotal)})   (informational; 018 strand 5 market-wide scope qualification)`);
  console.log(`  errors    : ${agg.errors} case(s) hit a runtime/model error`);

  const failures = scored.filter((s) => !s.toolModePass || (s.chartBearing && s.chartPass === false));
  console.log(RULE);
  console.log(`FAILURES (tool+mode or chart): ${failures.length}`);
  for (const s of failures) {
    const reasons: string[] = [];
    if (!s.toolModePass) reasons.push(`tool+mode expected ok, got tools=[${s.observedTools.join(",") || "(none)"}] mode=${s.observedMode}`);
    if (s.chartBearing && s.chartPass === false) reasons.push(`chart expected pick, got ${s.rawChartType ?? "(none)"}`);
    if (s.error) reasons.push(`error: ${s.error}`);
    console.log(`  [${s.id}] ${reasons.join("; ")}`);
  }
  console.log(HEAVY);
  console.log(
    `RESULT prompt=${prompt}  AC-7(tool+mode)=${ac7 ? "PASS" : "FAIL"} ${agg.toolModePass}/${agg.total}  AC-4(chart)=${ac4 ? "PASS" : "FAIL"} ${agg.chartPass}/${agg.chartTotal}`,
  );
  console.log(HEAVY);
}

// ---- main ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const prompt = parsePrompt(process.argv.slice(2));
  try {
    assertEvalEnabled();
  } catch (err) {
    console.error(`[eval] ${(err as Error).message}`);
    console.error(`[eval] parsed prompt: ${prompt} - nothing ran, no Bedrock calls made.`);
    process.exit(1);
  }

  const system = prompt === "v1" ? ADVISER_V1 : ADVISER_V2;
  // STALE BASELINE guard: v1 is frozen/unshipped and its text still instructs report_unanswerable, which
  // was RETIRED from the shared catalog (016) - a v1 run scores a prompt whose escape-hatch tool no longer
  // exists, so its tool/mode numbers are not comparable to v2. Do NOT re-tune v1; read v1 results as a
  // stale baseline only. (v2 is the shipped prompt; trigger/chat.ts wires it.)
  if (prompt === "v1") {
    console.warn("[eval] WARNING: --prompt v1 is a STALE baseline - report_unanswerable was retired from the catalog; v1's tool/mode numbers are not comparable to v2, and v1 is not to be re-tuned.");
  }
  const model = buildModel();

  console.log(HEAVY);
  console.log(`Job.Chat eval harness  |  prompt=${prompt}  |  model=${MODEL_ID}`);
  console.log(`${EVAL_SET.length} cases  |  ${CHART_BEARING.length} chart-bearing (AC-4 sample)`);
  console.log(HEAVY);

  const scored: ScoredCase[] = [];
  for (let i = 0; i < EVAL_SET.length; i++) {
    const observed = await runCase(model, system, EVAL_SET[i]);
    const s = scoreCase(EVAL_SET[i], observed);
    scored.push(s);
    printCase(i + 1, EVAL_SET[i], s);
  }
  printReport(prompt, scored);
}

if ((import.meta as { main?: boolean }).main === true) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
