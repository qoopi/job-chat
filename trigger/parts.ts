import { DataInsightSchema, type ChartType, type DataInsight, type DataPoint } from "@shared/insight";
import type { QueryResult, TemplateName } from "@shared/analytics";
import type { MessageRole, Store } from "@shared/store";
import { MAX_INPUT_CHARS, type GuardRefusal } from "./guard";

// The agent's part vocabulary: turning an analytics QueryResult into the ONE `data-insight` part per
// answer (built via the strict shared insight schema), the loading skeleton written before the tool
// returns, the compact model-facing view, the taxonomized error part, and the persistence extractor.
// Pure - no Trigger/Bedrock imports - so every mapping is unit-testable; trigger/chat.ts wires these
// to `chat.response.write` and the store.

/** The designated visual per catalog tool (brief case table; Q5/Q6 pinned to donut). */
const CHART_TYPE: Record<TemplateName, ChartType | "table"> = {
  salary_distribution: "histogram",
  salary_compare: "bars",
  postings_trend: "trend",
  top_companies: "bars",
  share_split: "donut",
  latest_postings: "table",
};

export function chartTypeFor(tool: TemplateName): ChartType | "table" {
  return CHART_TYPE[tool];
}

const FOLLOWUPS: Record<TemplateName, string[]> = {
  salary_distribution: ["How does this compare between cities?", "Which companies pay the most?"],
  salary_compare: ["What is the salary distribution here?", "Who is hiring the most?"],
  postings_trend: ["Which companies are hiring most?", "What is the experience-level mix?"],
  top_companies: ["What roles are they hiring for?", "How have postings trended lately?"],
  share_split: ["How does pay vary across these?", "Which companies are hiring most?"],
  latest_postings: ["What is the typical salary for these?", "Who else is hiring right now?"],
};

function num(value: unknown): number {
  return Math.round(Number(value));
}

/** The code-derived verdict sentence - always carries the real headline number (honesty, AC-4). */
function verdictFor(tool: TemplateName, rows: Record<string, unknown>[], params: unknown, sampleN: number): string {
  if (rows.length === 0) {
    return tool === "latest_postings" ? "No matching roles found." : "No data matches that query yet.";
  }
  const top = rows[0];
  switch (tool) {
    case "salary_distribution":
      return `The median salary is ${num(top.median)} across ${sampleN} postings.`;
    case "salary_compare":
      // With a single city row (the other city had no salaried postings) there is no comparison to
      // report, so state the one median plainly rather than claiming it "pays more" than an absent one.
      return rows.length < 2
        ? `The median salary in ${String(top.city)} is ${num(top.median)}.`
        : `${String(top.city)} pays more, with a median of ${num(top.median)}.`;
    case "postings_trend": {
      const total = rows.reduce((sum, r) => sum + num(r.count), 0);
      const days = (params as { days?: number })?.days;
      return days
        ? `${total} new postings in the last ${days} days.`
        : `${total} new postings in this window.`;
    }
    case "top_companies":
      return `${String(top.company)} is hiring the most, with ${num(top.count)} openings.`;
    case "share_split": {
      const total = rows.reduce((sum, r) => sum + num(r.count), 0);
      return `${String(top.label)} is the largest group at ${num(top.count)} of ${total}.`;
    }
    case "latest_postings":
      return `${rows.length} matching roles; the latest is ${String(top.title)}.`;
    default: {
      const exhaustive: never = tool;
      throw new Error(`no verdict for ${String(exhaustive)}`);
    }
  }
}

export interface BuildInsightArgs {
  id: string;
  tool: TemplateName;
  params: unknown;
  result: QueryResult;
}

/**
 * Build the single `data-insight` part for an answer: the code-derived verdict + designated visual +
 * the rows + follow-up chips + meta. Returned value is validated against the STRICT shared schema, so
 * an invalid shape fails loudly here (a test) rather than at persist/render time.
 */
export function buildInsight({ id, tool, params, result }: BuildInsightArgs): DataInsight {
  const visual = chartTypeFor(tool);
  const verdict = verdictFor(tool, result.rows, params, result.meta.sampleN);
  const followups = FOLLOWUPS[tool];
  // openSet threads through only when the predicate applied (AC-3); absent = full history, never injected.
  const meta = {
    sql: result.sql,
    sampleN: result.meta.sampleN,
    updatedAt: result.meta.freshestAt,
    ...(result.meta.openSet ? { openSet: true } : {}),
  };
  const data = result.rows as DataPoint[];

  const candidate =
    visual === "table"
      ? { id, kind: "table" as const, verdict, rows: data, followups, meta }
      : { id, kind: "chart" as const, chartType: visual, verdict, series: data, followups, meta };

  return DataInsightSchema.parse(candidate);
}

/** The loading part written first (same id as the filled insight, so the UI reconciles in place). */
export interface SkeletonPart {
  id: string;
  kind: "chart" | "table";
  chartType?: ChartType;
  status: "loading";
}

export function buildSkeleton(id: string, tool: TemplateName): SkeletonPart {
  const visual = chartTypeFor(tool);
  return visual === "table"
    ? { id, kind: "table", status: "loading" }
    : { id, kind: "chart", chartType: visual, status: "loading" };
}

/**
 * The marker a tool writes when its query matched NO rows. An empty result renders NO card - the answer
 * is plain prose (mode selection: empty result = plain mode). Written under the tool's part id so it
 * SUPERSEDES the loading skeleton in place (data parts reconcile last-write-wins by id), leaving no
 * dangling card. `status:"empty"` classifies as neither a valid insight nor an error/refusal, so the UI
 * renders nothing and `isPersistablePayload` drops it - the empty turn resumes as its plain prose alone.
 */
export interface EmptyPart {
  type: "data-insight";
  id: string;
  data: { status: "empty" };
}

export function emptyPart(id: string): EmptyPart {
  return { type: "data-insight", id, data: { status: "empty" } };
}

/**
 * The compact model-facing signal for an empty (0-row) tool result: no postings matched, so the model
 * must answer in plain prose (no chart, no invented numbers) rather than narrate a retry or emit a card.
 */
export function emptyModelOutput(tool: TemplateName): { empty: true; tool: TemplateName; note: string } {
  return {
    empty: true,
    tool,
    note: "No postings matched this query - there is nothing to chart. Answer in plain prose (at most two sentences) that there is no matching data yet; do not invent numbers and do not describe the tool call.",
  };
}

/** A compact view for the model - the verdict + counts, never the full rows (keeps context small). */
export function toModelOutput(insight: DataInsight): {
  verdict: string;
  visual: ChartType | "table";
  sampleN: number;
  shown: number;
} {
  const rows = insight.kind === "chart" ? insight.series : insight.rows;
  return {
    verdict: insight.verdict,
    visual: insight.kind === "chart" ? insight.chartType : "table",
    sampleN: insight.meta.sampleN,
    shown: rows.length,
  };
}

export type AgentErrorKind = "system" | "unanswerable";

export interface ErrorPart {
  type: "data-error";
  id: string;
  data: { kind: AgentErrorKind };
}

/**
 * The error part (AC-10). `system` = a tool/infra failure ("something went wrong on my side");
 * `unanswerable` = a question the data cannot answer. The user-facing copy lives in the UI (005/006);
 * the agent only tags the kind so retry/copy can branch.
 */
export function errorPart(id: string, kind: AgentErrorKind): ErrorPart {
  return { type: "data-error", id, data: { kind } };
}

// The reasons the agent streams as a data-refusal part: the cap/budget guard backstop (GuardRefusal)
// plus the input-size backstop (`too_long`) refused at the run() ingress before persist/model. The UI
// renders every one of these as a polite RefusalNotice (src/lib/chat-ui.ts classifier + refusalCopy),
// so this union must stay in step with that handling.
export type RefusalPartReason = GuardRefusal | "too_long";

export interface RefusalPart {
  type: "data-refusal";
  id: string;
  data: { reason: RefusalPartReason };
}

/**
 * The refusal part (AC-15 cap / AC-20 daily budget, plus `too_long` for an over-length turn), streamed
 * by the agent-side backstop when a turn is refused before the model. A DISTINCT taxonomy from
 * `data-error`: not a failure, but a polite limit - the client renders it like the server action's
 * typed refusal, not the error card.
 */
export function refusalPart(id: string, reason: RefusalPartReason): RefusalPart {
  return { type: "data-refusal", id, data: { reason } };
}

type MessagePartLike = { type: string; text?: string; id?: string; data?: unknown };
type MessageLike = { parts?: MessagePartLike[] };

// A persisted card payload is a strict-valid insight, an error marker, or a refusal marker - anything
// else (notably a loading skeleton, whose `status:"loading"` fails every branch) is dropped so a
// failed/refused turn never resumes as a stuck spinner.
function isPersistablePayload(data: unknown): boolean {
  if (DataInsightSchema.safeParse(data).success) return true;
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.kind === "system" || d.kind === "unanswerable") return true; // error marker
  if (d.reason === "guest_cap" || d.reason === "daily_budget" || d.reason === "too_long") return true; // refusal marker
  return false;
}

/**
 * Extract the persisted assistant content + card payload from a completed turn's response message.
 * Text parts are joined; the card parts (`data-insight`, `data-error`, `data-refusal`) are de-duped
 * by id - last write wins, so a skeleton is superseded by its filled insight (success) or by the
 * error/refusal emitted under the same id (failure). Loading skeletons that were never superseded are
 * then dropped (they fail `isPersistablePayload`), so a failed or refused turn resumes as its error /
 * refusal card, never a stuck skeleton. Payload: a single object for the usual one-card answer, an
 * array if several, `null` for a plain text-only answer. AC-13 resume source.
 */
export function extractAssistantPersistence(message: MessageLike): {
  content: string;
  parts: unknown;
} {
  const parts = message.parts ?? [];
  const content = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  const byId = new Map<string, unknown>();
  let anon = 0;
  for (const p of parts) {
    if (p.type === "data-insight" || p.type === "data-error" || p.type === "data-refusal") {
      byId.set(p.id ?? `#${anon++}`, p.data);
    }
  }
  const payloads = [...byId.values()].filter(isPersistablePayload);
  const payload = payloads.length === 0 ? null : payloads.length === 1 ? payloads[0] : payloads;
  return { content, parts: payload };
}

/**
 * Persist the assistant turn (content + card payload) via the store. Called from the agent's
 * `onTurnComplete` on both normal and stopped completion (AC-13; the stopped case is the cancelled-
 * run partial-persistence path).
 */
export async function persistAssistantTurn(
  store: Store,
  args: { conversationId: string; responseMessage: MessageLike },
): Promise<void> {
  const { content, parts } = extractAssistantPersistence(args.responseMessage);
  await store.appendMessage(args.conversationId, "assistant", content, parts);
}


/** Read a model message's user text (content is a string or an array of text parts). */
function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: string; text?: unknown } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
    )
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

/** A run's reconstructed history is model messages - only the role + user text matter for persistence. */
export type RunMessage = { role: string; content?: unknown };

/** A model-input message: role + text content - the alternating history the model replays each turn. */
export type ModelMessage = { role: MessageRole; content: string };

/**
 * Rebuild the model-input history for a turn from the store's persisted conversation - the SOURCE OF
 * TRUTH (004 round 4 fix). The SDK reconstructs its cross-turn model input from the durable session
 * replay, which across a continuation boot carries the prior USER messages but NOT their ASSISTANT
 * answers; the model then sees a pile of unanswered questions and re-answers every one. Postgres holds
 * the full, correct history (persisted by `startConversation`, `persistIncomingUserTurns`, and
 * `persistAssistantTurn`), so the durable run rebuilds the model input from it instead of trusting the
 * SDK replay - turn N gets the full alternating user+assistant history with the newest user message as
 * the sole trailing turn.
 *
 * Only role + text `content` reach the model (the card payload is a UI artifact, and each assistant
 * verdict already carries its headline number in prose, so plain text is a faithful, compact record of
 * what the assistant said). Empty-content rows are dropped so a refused/errored turn - persisted with
 * empty content - never emits an invalid empty model message.
 */
export function buildModelHistory(messages: { role: MessageRole; content: string }[]): ModelMessage[] {
  return messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Persist the newly-arrived user turn(s) present in the run's reconstructed `messages` but not yet in
 * the store, BEFORE the guard backstop counts them. Mechanism (a): a follow-up is delivered by the
 * client transport's `sendMessages` (append to `.in` + subscribe-with-wait - the only SDK 4.5.4 path
 * that streams a freshly-triggered turn live; `reconnectToStream` forces peekSettled), so the user turn
 * is no longer persisted by the server action - the agent's `run()` is the single persist site.
 *
 * Count-based (persist the tail of user messages beyond what the store already holds), so it is a no-op
 * on turn-1 arrival (`startConversation` already persisted message #1 before triggering) and on
 * regenerate (no new user turn) - it never double-persists. Idempotent across a run retry for the same
 * reason: once persisted, the stored count catches up and the tail is empty.
 *
 * Input-size backstop (both-layers, mirrors the cap/budget guard): the client transport appends a
 * follow-up to `.in` with only a write-scoped token, bypassing the action's `TextSchema` gate. So an
 * over-length NEW turn is refused HERE - returning "too_long" and persisting NOTHING - before the
 * oversized payload can reach Postgres or Bedrock. The bound is the SAME `MAX_INPUT_CHARS` the action
 * enforces (imported from ./guard, no duplicate literal), applied to the trimmed text like `TextSchema`,
 * so the two layers cannot drift. `null` means the turn(s) were within bound and persisted (or a no-op).
 */
export async function persistIncomingUserTurns(
  store: Store,
  chatId: string,
  messages: RunMessage[],
): Promise<"too_long" | null> {
  const incoming = messages.filter((m) => m.role === "user").map((m) => userMessageText(m.content));
  const loaded = await store.getConversation(chatId);
  const persistedUserCount = loaded ? loaded.messages.filter((m) => m.role === "user").length : 0;
  const newTurns = incoming.slice(persistedUserCount);
  if (newTurns.some((text) => text.trim().length > MAX_INPUT_CHARS)) return "too_long";
  for (const text of newTurns) {
    if (text.trim().length === 0) continue;
    await store.appendMessage(chatId, "user", text, null);
  }
  return null;
}
