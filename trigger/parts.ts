import { DataInsightSchema, type ChartType, type DataInsight, type DataPoint } from "@shared/insight";
import type { QueryResult, TemplateName } from "@shared/analytics";
import type { Store } from "@shared/store";

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
      return `${String(top.city)} pays more, with a median of ${num(top.median)}.`;
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
  const meta = { sql: result.sql, sampleN: result.meta.sampleN, updatedAt: result.meta.freshestAt };
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

type MessagePartLike = { type: string; text?: string; id?: string; data?: unknown };
type MessageLike = { parts?: MessagePartLike[] };

/**
 * Extract the persisted assistant content + card payload from a completed turn's response message.
 * Text parts are joined; `data-insight` parts are de-duped by id (last write wins, so a skeleton is
 * superseded by its filled part) and returned as the payload (single object for the usual one-card
 * answer, array if several, `null` for a plain text-only answer). AC-13 resume source.
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
    if (p.type === "data-insight") byId.set(p.id ?? `#${anon++}`, p.data);
  }
  const insights = [...byId.values()];
  const payload = insights.length === 0 ? null : insights.length === 1 ? insights[0] : insights;
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
