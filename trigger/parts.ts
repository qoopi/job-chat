import {
  DataInsightSchema,
  labelKeyOf,
  type ChartType,
  type DataInsight,
  type DataPoint,
  type ErrorKind,
  type RefusalReason,
} from "@shared/insight";
import type { QueryResult, TemplateName } from "@shared/analytics";
import type { MessageRole } from "@shared/store";

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

const DONUT_MAX_SLICES = 6;

export const MIN_TREND_POINTS = 3;

export const FRAGMENTATION = {
  // A ranked COUNT grouping is noise when its leader holds LESS than this share of the sample (many
  // near-equal tiny groups); below the floor the verdict says "no single X dominates" instead of crowning it.
  minLeaderShare: 0.1,
} as const;

export function sumCount(rows: Record<string, unknown>[]): number {
  return rows.reduce((sum, r) => sum + num(r.count), 0);
}

/** A donut is honest only for a TRUE whole (readable slice count summing to the sample); else fall back to bars. */
function donutIsWhole(rowCount: number, sliceSum: number, sampleN: number): boolean {
  return rowCount <= DONUT_MAX_SLICES && sliceSum === sampleN;
}

export interface ComposedShape {
  measures: readonly string[];
  dimensions?: readonly string[];
  bucket?: string;
  role?: string;
  company?: string;
  city?: string;
  cities?: string[];
  region?: string;
  country?: string;
  experience_level?: string;
  employment_type?: string;
  location_kind?: string;
  days?: number;
  min_salary?: number;
  max_salary?: number;
  // A custom `sort` is WHY rows[0] is not always the max (the agent can ask dir:"asc"); the verdict verifies
  // the extreme from the ROWS themselves, never trusting this field.
  sort?: { by: string; dir: "asc" | "desc" };
}

/** Deterministic server-side chart fallback for query_postings: returns the SERVED type - the agent's raw
 *  pick when it fits the data shape, else the shape's fit type (bucket->trend, one dim->bars or a true-whole
 *  COUNT donut, two keys/bare aggregate->table). */
export function chartTypeForShape(
  shape: { dimensions?: readonly string[]; bucket?: string; measures?: readonly string[] },
  rawPick: ChartType | "table",
  rowCount: number,
  // When provided, a donut additionally requires its slices to sum to the sample (a true whole).
  wholeness?: { sliceSum: number; sampleN: number },
): ChartType | "table" {
  const dims = shape.dimensions?.length ?? 0;
  const keys = dims + (shape.bucket ? 1 : 0);
  if (keys >= 2) return "table"; // a cross-tab / entity-ish result
  if (shape.bucket) return rowCount >= MIN_TREND_POINTS ? "trend" : "table"; // a trend needs >=3 points
  if (dims === 1) {
    // Two measures on one axis share no scale (a count next to a salary) - a table, not shared-axis bars.
    if ((shape.measures?.length ?? 1) >= 2) return "table";
    const countShare = shape.measures?.length === 1 && shape.measures[0] === "count";
    const whole = !wholeness || donutIsWhole(rowCount, wholeness.sliceSum, wholeness.sampleN);
    return rawPick === "donut" && countShare && rowCount <= DONUT_MAX_SLICES && whole ? "donut" : "bars";
  }
  return "table"; // no grouping key: a single-row aggregate
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

/** Label copy for a group value; a null/empty (searchnapply defaults absent city/level to null/"") reads as "unspecified". */
export const LABEL_FALLBACK = "unspecified";
function labelText(value: unknown): string {
  return value === null || value === undefined || value === "" ? LABEL_FALLBACK : String(value);
}

function verdictFor(tool: TemplateName, rows: Record<string, unknown>[], params: unknown, sampleN: number): string {
  if (rows.length === 0) {
    return tool === "latest_postings" ? "No matching roles found." : "No data matches that query yet.";
  }
  const top = rows[0];
  switch (tool) {
    case "salary_distribution":
      return `The median salary is ${num(top.median)} across ${sampleN} postings.`;
    case "salary_compare": {
      // Single city row (the other had no salaried postings): state the one median, don't claim it "pays more".
      if (rows.length < 2) return `The median salary in ${String(top.city)} is ${num(top.median)}.`;
      const second = rows[1];
      // Equal medians is a tie, not a win - "about the same" instead of a false "pays more".
      if (num(top.median) === num(second.median)) {
        return `Pay is about the same in ${String(top.city)} and ${String(second.city)}, around ${num(top.median)}.`;
      }
      return `${String(top.city)} pays more, with a median of ${num(top.median)}.`;
    }
    case "postings_trend": {
      // sampleN is the ONE denominator - never rows.reduce, which a LIMIT could truncate below the true total.
      const days = (params as { days?: number })?.days;
      return days
        ? `${sampleN} new postings in the last ${days} days.`
        : `${sampleN} new postings in this window.`;
    }
    case "top_companies":
      return `${String(top.company)} is hiring the most, with ${num(top.count)} openings.`;
    case "share_split":
      return `${String(top.label)} is the largest group at ${num(top.count)} of ${sampleN}.`;
    case "latest_postings":
      return `${rows.length} matching roles; the latest is ${String(top.title)}.`;
    default: {
      const exhaustive: never = tool;
      throw new Error(`no verdict for ${String(exhaustive)}`);
    }
  }
}

const COMPOSED_MEASURE_LABEL: Record<string, string> = {
  count: "postings",
  median_salary: "median salary",
  p25_salary: "25th-percentile salary",
  p75_salary: "75th-percentile salary",
};

/** The generic composed verdict (leads with the key number). For a single-dim ranking it names ONLY the
 *  extreme it can VERIFY from the rows (the agent can sort ASC, so rows[0] is never assumed to lead); when
 *  rows[0] is neither extreme it leads with the total/range - no false superlative is ever claimed. */
function verdictForComposed(params: ComposedShape, rows: Record<string, unknown>[], sampleN: number): string {
  const measure = params.measures[0];
  const top = rows[0];
  const dimKey = params.dimensions?.[0];
  // A ranking only for EXACTLY one dimension and no bucket: a 2-dim cross-tab's top row is one cell (not the
  // group leader), a bucketed result is a trend - both aggregate instead of naming a leader.
  const ranked = params.dimensions?.length === 1 && !params.bucket;

  if (measure === "count") {
    // sampleN (the whole) is the ONLY denominator - never rows.reduce, which the top-N LIMIT truncates.
    if (ranked) {
      const counts = rows.map((r) => num(r.count));
      const topCount = num(top.count);
      // Verify from the rows which extreme rows[0] holds - a custom `sort:{dir:"asc"}` makes it the min.
      if (counts.every((c) => c <= topCount)) {
        if (sampleN > 0 && topCount / sampleN < FRAGMENTATION.minLeaderShare) {
          const dimName = DIM_LABEL[dimKey!] ?? dimKey!;
          return `No single ${dimName} dominates - the largest, ${labelText(top[dimKey!])}, has ${topCount} of ${sampleN} postings.`;
        }
        // A top-two tie (rows count-DESC, rows[1] == top) is shared, not a leader - say "level", not "leads with".
        const runnerUp = rows[1];
        if (runnerUp !== undefined && num(runnerUp.count) === topCount) {
          return `${labelText(top[dimKey!])} and ${labelText(runnerUp[dimKey!])} are level, each ${topCount} of ${sampleN} postings.`;
        }
        return `${labelText(top[dimKey!])} leads with ${topCount} of ${sampleN} postings.`;
      }
      if (counts.every((c) => c >= topCount)) return `${labelText(top[dimKey!])} has the fewest, with ${topCount} of ${sampleN} postings.`;
    }
    return `${sampleN} postings in total.`;
  }

  const label = COMPOSED_MEASURE_LABEL[measure] ?? measure;
  const values = rows.map((r) => num(r[measure]));
  if (ranked) {
    const topVal = num(top[measure]);
    if (values.every((v) => v <= topVal)) return `${labelText(top[dimKey!])} has the highest ${label} at ${topVal}.`;
    if (values.every((v) => v >= topVal)) return `${labelText(top[dimKey!])} has the lowest ${label} at ${topVal}.`;
  }
  if (dimKey === undefined && !params.bucket) return `The ${label} is ${num(top[measure])}.`;
  // The min/max are over the shown (sorted + LIMITed) slice, so say so - never imply a full-corpus range.
  return `The ${label} ranges from ${Math.min(...values)} to ${Math.max(...values)} across the ${rows.length} shown.`;
}

// The "widen" chip drops the most-selective active filter (by this precedence).
const WIDEN_PRECEDENCE = [
  "role", "company", "city", "cities", "region", "country",
  "experience_level", "employment_type", "location_kind", "days",
] as const;
const WIDEN_PHRASE: Record<string, string> = {
  role: "across all roles",
  company: "across all companies",
  city: "across all cities",
  cities: "across all cities",
  region: "across all regions",
  country: "worldwide",
  experience_level: "across all experience levels",
  employment_type: "across all employment types",
  location_kind: "across all work arrangements",
  days: "over all time",
};

// The "pivot" chip swaps to an unused dimension (first by this preference not already used or filter-pinned).
const PIVOT_PREFERENCE = [
  "company", "experience_level", "location_kind", "country", "city", "region", "employment_type", "title",
] as const;
const DIM_LABEL: Record<string, string> = {
  company: "company", city: "city", region: "region", country: "country",
  experience_level: "experience level", employment_type: "employment type",
  location_kind: "work arrangement", title: "role",
};
// Which dimension each equality filter pins (so a pivot never lands on an already-fixed value).
const FILTER_PINS_DIM: Record<string, string> = {
  role: "title", company: "company", city: "city", cities: "city", region: "region", country: "country",
  experience_level: "experience_level", employment_type: "employment_type", location_kind: "location_kind",
};

function widenChip(params: ComposedShape): string | null {
  const p = params as unknown as Record<string, unknown>;
  for (const f of WIDEN_PRECEDENCE) {
    if (p[f] !== undefined) return `How does this look ${WIDEN_PHRASE[f]}?`;
  }
  return null;
}

function pivotChip(params: ComposedShape): string | null {
  const p = params as unknown as Record<string, unknown>;
  const used = new Set<string>(params.dimensions ?? []);
  for (const [filter, dim] of Object.entries(FILTER_PINS_DIM)) {
    if (p[filter] !== undefined) used.add(dim);
  }
  for (const d of PIVOT_PREFERENCE) {
    if (!used.has(d)) return `Break this down by ${DIM_LABEL[d]}.`;
  }
  return null;
}

/** Two deterministic follow-up chips (no LLM): widen + pivot, with generic backfill to always yield two distinct chips. */
export function composedFollowups(params: ComposedShape): string[] {
  const candidates = [
    widenChip(params),
    pivotChip(params),
    params.bucket ? null : "How has this changed over time?",
    "Which companies are hiring the most?",
    "What is the experience-level mix?",
  ];
  const chips: string[] = [];
  for (const c of candidates) {
    if (c && !chips.includes(c)) chips.push(c);
    if (chips.length === 2) break;
  }
  return chips;
}

export interface BuildInsightArgs {
  id: string;
  tool: TemplateName;
  params: unknown;
  result: QueryResult;
}

/** Assemble + strict-validate a data-insight from its visual/verdict/follow-ups (shared by the template and
 *  composed paths). An invalid shape fails loudly HERE (a test), not at persist/render time. */
function assembleInsight(
  id: string,
  visual: ChartType | "table",
  verdict: string,
  followups: string[],
  result: QueryResult,
): DataInsight {
  // openSet threads only when the predicate applied (absent = full history); currency only for a salary
  // aggregate (so the source line/table disclose the real base). Neither is injected.
  const meta = {
    sql: result.sql,
    sampleN: result.meta.sampleN,
    updatedAt: result.meta.freshestAt,
    ...(result.meta.openSet ? { openSet: true } : {}),
    ...(result.meta.currency ? { currency: result.meta.currency } : {}),
  };
  // Chart labels are coalesced (null/empty -> "unspecified"); a table keeps cells verbatim (DataTable shows "-").
  const data = (visual === "table" ? result.rows : coalesceSeriesLabels(result.rows)) as DataPoint[];
  const candidate =
    visual === "table"
      ? { id, kind: "table" as const, verdict, rows: data, followups, meta }
      : { id, kind: "chart" as const, chartType: visual, verdict, series: data, followups, meta };
  return DataInsightSchema.parse(candidate);
}

/** Coalesce null/empty LABEL-column values to "unspecified" so no group label renders blank; measures untouched. */
function coalesceSeriesLabels(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length === 0) return rows;
  const labelKeys = Object.keys(rows[0]).filter((k) => rows.some((r) => typeof r[k] === "string"));
  if (labelKeys.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const k of labelKeys) if (out[k] === null || out[k] === "") out[k] = LABEL_FALLBACK;
    return out;
  });
}

export function buildInsight({ id, tool, params, result }: BuildInsightArgs): DataInsight {
  const rows = result.rows;
  const sampleN = result.meta.sampleN;
  // The pinned template visual, signal-corrected: too-few-point trend -> table; non-whole donut -> bars.
  let visual = chartTypeFor(tool);
  if (visual === "trend" && rows.length < MIN_TREND_POINTS) visual = "table";
  if (visual === "donut" && !donutIsWhole(rows.length, sumCount(rows), sampleN)) visual = "bars";
  return assembleInsight(id, visual, verdictFor(tool, rows, params, sampleN), FOLLOWUPS[tool], result);
}

export interface BuildComposedInsightArgs {
  id: string;
  params: ComposedShape;
  chartType: ChartType | "table";
  result: QueryResult;
}

/** Build the data-insight for a query_postings answer (parallel to buildInsight; not TemplateName-keyed). */
export function buildComposedInsight({
  id,
  params,
  chartType,
  result,
}: BuildComposedInsightArgs): DataInsight {
  return assembleInsight(
    id,
    chartType,
    verdictForComposed(params, result.rows, result.meta.sampleN),
    composedFollowups(params),
    result,
  );
}

export interface SkeletonPart {
  id: string;
  kind: "chart" | "table";
  chartType?: ChartType;
  status: "loading";
}

function skeletonFor(id: string, visual: ChartType | "table"): SkeletonPart {
  return visual === "table"
    ? { id, kind: "table", status: "loading" }
    : { id, kind: "chart", chartType: visual, status: "loading" };
}

export function buildSkeleton(id: string, tool: TemplateName): SkeletonPart {
  return skeletonFor(id, chartTypeFor(tool));
}

export function buildComposedSkeleton(id: string, chartType: ChartType | "table"): SkeletonPart {
  return skeletonFor(id, chartType);
}

/** The marker a tool writes for a 0-row result: renders NO card (plain-prose answer). Same id as the skeleton
 *  so it supersedes it; classified as neither insight nor error, so it renders nothing and isn't persisted. */
export interface EmptyPart {
  type: "data-insight";
  id: string;
  data: { status: "empty" };
}

export function emptyPart(id: string): EmptyPart {
  return { type: "data-insight", id, data: { status: "empty" } };
}

/** Model-facing signal for a 0-row result: answer in plain prose, no chart, no invented numbers. */
export function emptyModelOutput(tool: string): { empty: true; tool: string; note: string } {
  return {
    empty: true,
    tool,
    note: "No postings matched this query - there is nothing to chart. Answer in plain prose (at most two sentences) that there is no matching data yet; do not invent numbers and do not describe the tool call.",
  };
}

/** Model-facing signal for a bare single-number aggregate: no card is shown (a one-value chart adds
 *  nothing over the sentence), so restate the figure in one plain sentence. The verdict already holds it. */
export function scalarModelOutput(verdict: string): { scalar: true; verdict: string; note: string } {
  return {
    scalar: true,
    verdict,
    note: "This is a single number, so no chart is shown. State it in one short plain sentence (two at most) using the figure in the verdict; do not describe the tool call.",
  };
}

/** Entity labels (first string column, capped) that ground the model's reasoning in what it got back -
 *  the prompt forbids naming any entity absent from this list. */
const MODEL_LABEL_CAP = 12;
function rowLabels(rows: DataPoint[]): string[] {
  const first = rows[0];
  if (!first) return [];
  // One home for the label-column decision (shared with the chart reading), so labels never diverge.
  const key = labelKeyOf(rows);
  if (typeof first[key] === "number") return []; // no non-numeric label column: no entities to ground on
  return rows.slice(0, MODEL_LABEL_CAP).map((r) => labelText(r[key]));
}

export function toModelOutput(insight: DataInsight): {
  verdict: string;
  visual: ChartType | "table";
  sampleN: number;
  shown: number;
  labels: string[];
} {
  const rows = insight.kind === "chart" ? insight.series : insight.rows;
  return {
    verdict: insight.verdict,
    visual: insight.kind === "chart" ? insight.chartType : "table",
    sampleN: insight.meta.sampleN,
    shown: rows.length,
    labels: rowLabels(rows),
  };
}

export interface ErrorPart {
  type: "data-error";
  id: string;
  data: { kind: ErrorKind };
}

/** The error part: `system` = tool/infra failure, `unanswerable` = the data cannot answer; UI owns the copy. */
export function errorPart(id: string, kind: ErrorKind): ErrorPart {
  return { type: "data-error", id, data: { kind } };
}

export interface RefusalPart {
  type: "data-refusal";
  id: string;
  data: { reason: RefusalReason };
}

/** The refusal part (cap/budget/too_long), streamed before the model. Distinct from data-error: a polite limit, not a failure. */
export function refusalPart(id: string, reason: RefusalReason): RefusalPart {
  return { type: "data-refusal", id, data: { reason } };
}

export type ModelMessage = { role: MessageRole; content: string };

/** The text the MODEL sees per turn: an assistant CARD turn contributes the code-derived VERDICT (never the
 *  model's own prose), "" for an error/refusal card; user / card-less turns keep their content verbatim. */
function modelFacingContent(m: { role: MessageRole; content: string; parts?: unknown }): string {
  if (m.role !== "assistant" || m.parts == null) return m.content;
  const payloads = Array.isArray(m.parts) ? m.parts : [m.parts];
  const verdicts = payloads
    .map((p) => {
      const parsed = DataInsightSchema.safeParse(p);
      return parsed.success ? parsed.data.verdict : null;
    })
    .filter((v): v is string => v !== null);
  return verdicts.length > 0 ? verdicts.join(" ") : "";
}

/** Rebuild the model-input history from the store (the SOURCE OF TRUTH): the SDK's cross-turn replay carries
 *  prior USER messages but NOT their ASSISTANT answers, so the model would re-answer every question. Per turn:
 *  modelFacingContent (a card turn -> its verdict, error/refusal -> "", plain -> verbatim); empty rows dropped.
 *  Dropping an empty error/refusal row can leave two SAME-ROLE rows adjacent (user,user), which Bedrock's strict
 *  role-alternation REJECTS - so consecutive same-role rows are COALESCED (text joined). Heals only the model
 *  input; persistence is untouched. */
export function buildModelHistory(
  messages: { role: MessageRole; content: string; parts?: unknown }[],
): ModelMessage[] {
  const merged: ModelMessage[] = [];
  for (const m of messages) {
    const content = modelFacingContent(m);
    if (content.trim().length === 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n${content}`;
    else merged.push({ role: m.role, content });
  }
  return merged;
}
