import {
  DataInsightSchema,
  type ChartType,
  type DataInsight,
  type DataPoint,
  type ErrorKind,
  type RefusalReason,
} from "@shared/insight";
import type { QueryResult, TemplateName } from "@shared/analytics";
import type { MessageRole } from "@shared/store";

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

/** How many slices a donut stays readable at; a donut pick beyond this is corrected to bars (AC-4). */
const DONUT_MAX_SLICES = 6;

/** A trend needs at least this many points to read as a line; fewer routes to a table (018 strand 3). */
export const MIN_TREND_POINTS = 3;

/** Signal-quality thresholds (018 strand 3). One exported home so the gate is tunable in one place. */
export const FRAGMENTATION = {
  // A ranked COUNT grouping is noise (no dominant group) when its leader holds LESS than this share of
  // the sample - many near-equal tiny groups, e.g. 3,023 distinct titles over 3,257 postings (~1 each).
  // Below the floor the verdict says "no single <dimension> dominates" instead of crowning the noise.
  minLeaderShare: 0.1,
} as const;

/** Sum the `count` measure across the shown rows (the donut wholeness + fragmentation checks). */
export function sumCount(rows: Record<string, unknown>[]): number {
  return rows.reduce((sum, r) => sum + num(r.count), 0);
}

/** A donut is honest only for a TRUE whole: a readable slice count whose slices sum to the sample (so
 *  the ring accounts for every posting, not a truncated top-N). Else the visual falls back to bars. */
function donutIsWhole(rowCount: number, sliceSum: number, sampleN: number): boolean {
  return rowCount <= DONUT_MAX_SLICES && sliceSum === sampleN;
}

/** The subset of the composed params (@shared/analytics ComposedQuery) the parts path reads. */
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
  // Carried so this shape matches the tool's parsed params: a custom `sort` is WHY rows[0] is not always
  // the max (the agent can ask for `dir:"asc"`). The verdict verifies the extreme from the ROWS
  // themselves (sort-agnostic), so it never trusts this field to decide the leader.
  sort?: { by: string; dir: "asc" | "desc" };
}

/**
 * The deterministic server-side chart fallback for query_postings (AC-4). The agent proposes a
 * chartType (the RAW pick, recorded by the tool BEFORE this runs); this returns the SERVED type: the
 * pick when it fits the data shape, else the shape's fit type. Shapes: a time bucket is a trend; a
 * single categorical dimension is a comparison (bars), or a share-of-whole donut when the agent asked
 * for one AND it is a COUNT measure (ruling 29 - a donut is a share of a whole, meaningful only for a
 * count; median/p25/p75 are never a donut) AND it stays readable (<= DONUT_MAX_SLICES slices); two
 * grouping keys (2 dims, or a dim + a bucket) or a bare aggregate are an entity-ish table. No histogram
 * branch - the value-bucket histogram shape is unreachable in the composed param space (v1
 * salary_distribution owns it).
 */
export function chartTypeForShape(
  shape: { dimensions?: readonly string[]; bucket?: string; measures?: readonly string[] },
  rawPick: ChartType | "table",
  rowCount: number,
  // When provided, a donut additionally requires its slices to sum to the sample (a true whole, 018
  // strand 3). Absent (older callers / tests) leaves the wholeness invariant unchecked.
  wholeness?: { sliceSum: number; sampleN: number },
): ChartType | "table" {
  const dims = shape.dimensions?.length ?? 0;
  const keys = dims + (shape.bucket ? 1 : 0);
  if (keys >= 2) return "table"; // a cross-tab / entity-ish result
  if (shape.bucket) return rowCount >= MIN_TREND_POINTS ? "trend" : "table"; // a trend needs >=3 points
  if (dims === 1) {
    // Two measures on one categorical axis share no scale (a count next to a salary) - a table, never
    // shared-axis bars (018 strand 3).
    if ((shape.measures?.length ?? 1) >= 2) return "table";
    // Ruling 29 + strand 3: a donut only for a single COUNT measure that is a TRUE whole (slices sum to
    // the sample) and stays readable (<= slice cap); any salary measure or a truncated/oversized share
    // falls back to bars.
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

/** The label copy for a group value used in verdicts/series - null or the empty string (searchnapply
 *  defaults absent city/level to null/"") reads as "unspecified", never a bare "null" leading a claim. */
export const LABEL_FALLBACK = "unspecified";
function labelText(value: unknown): string {
  return value === null || value === undefined || value === "" ? LABEL_FALLBACK : String(value);
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
    case "salary_compare": {
      // With a single city row (the other city had no salaried postings) there is no comparison to
      // report, so state the one median plainly rather than claiming it "pays more" than an absent one.
      if (rows.length < 2) return `The median salary in ${String(top.city)} is ${num(top.median)}.`;
      const second = rows[1];
      // Equal medians is a tie, not a win - "about the same" instead of a false "pays more" (018 strand 3).
      if (num(top.median) === num(second.median)) {
        return `Pay is about the same in ${String(top.city)} and ${String(second.city)}, around ${num(top.median)}.`;
      }
      return `${String(top.city)} pays more, with a median of ${num(top.median)}.`;
    }
    case "postings_trend": {
      // sampleN (count over the same window) is the ONE denominator - never rows.reduce, which a LIMIT
      // could truncate below the true total. It equals the source line's number by construction.
      const days = (params as { days?: number })?.days;
      return days
        ? `${sampleN} new postings in the last ${days} days.`
        : `${sampleN} new postings in this window.`;
    }
    case "top_companies":
      return `${String(top.company)} is hiring the most, with ${num(top.count)} openings.`;
    case "share_split":
      // The share base is sampleN (the whole), not the sum of the shown slices (a LIMIT could truncate
      // them) - so the verdict's "of N" always matches the source line.
      return `${String(top.label)} is the largest group at ${num(top.count)} of ${sampleN}.`;
    case "latest_postings":
      return `${rows.length} matching roles; the latest is ${String(top.title)}.`;
    default: {
      const exhaustive: never = tool;
      throw new Error(`no verdict for ${String(exhaustive)}`);
    }
  }
}

// ---- query_postings composed parts (a parallel path; NOT keyed by TemplateName) -------------------

/** Human labels for the composed measures - used in the generic verdict. */
const COMPOSED_MEASURE_LABEL: Record<string, string> = {
  count: "postings",
  median_salary: "median salary",
  p25_salary: "25th-percentile salary",
  p75_salary: "75th-percentile salary",
};

/**
 * The generic composed verdict - leads with the key number (honesty), like the per-template verdicts.
 * Count is summable into a headline total; salary quantiles are not. For a single-dimension, non-bucketed
 * result (a ranking), the verdict names ONLY the extreme it can VERIFY from the rows: rows[0] as the
 * leader / highest when it genuinely holds the max, or as the fewest / lowest when it holds the min - the
 * agent can sort ASCENDING (the natural pick for "which city pays the LEAST"), so rows[0] is never assumed
 * to lead. When rows[0] is neither extreme (sorted by some other key), or for a trend / cross-tab / bare
 * aggregate, the verdict leads with the total (count) or the observed range (salary) - so no false
 * superlative is ever claimed.
 */
function verdictForComposed(params: ComposedShape, rows: Record<string, unknown>[], sampleN: number): string {
  const measure = params.measures[0];
  const top = rows[0];
  const dimKey = params.dimensions?.[0];
  // A ranking only when there is EXACTLY one dimension and no bucket. A 2-dim cross-tab's top row is one
  // cell, NOT the group leader (its group's other rows can sum higher); a bucketed result is a trend.
  // Neither is a ranking, so both aggregate instead of naming a leader.
  const ranked = params.dimensions?.length === 1 && !params.bucket;

  if (measure === "count") {
    // sampleN (the whole) is the ONLY denominator - never rows.reduce, which the top-N LIMIT truncates
    // (e.g. 20 shown titles of 3,257 postings), so "of N" would disagree with the source line.
    if (ranked) {
      const counts = rows.map((r) => num(r.count));
      const topCount = num(top.count);
      // Verify from the rows which extreme rows[0] holds - a custom `sort:{dir:"asc"}` makes it the min.
      if (counts.every((c) => c <= topCount)) {
        // rows[0] holds the max - about to name a leader. If it commands too small a share, the grouping
        // is noise (many near-equal tiny groups, e.g. 3,023 distinct titles) - refuse to crown it.
        if (sampleN > 0 && topCount / sampleN < FRAGMENTATION.minLeaderShare) {
          const dimName = DIM_LABEL[dimKey!] ?? dimKey!;
          return `No single ${dimName} dominates - the largest, ${labelText(top[dimKey!])}, has ${topCount} of ${sampleN} postings.`;
        }
        // A top-two tie (both above the floor) is not a leader - say "level", never a false "leads with"
        // superlative (018 review-fix; extends rec 9's salary tie to count rankings). Rows are count-DESC,
        // so rows[1] equal to the top means the lead is shared.
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

// The "widen" chip drops the most-selective active filter. Precedence RECORDED in the epic decision
// log (2026-07-20): role > company > city > region > country > experience_level > employment_type >
// location_kind > days.
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

// The "pivot" chip swaps to an unused dimension - the first by this preference that is neither already
// a dimension nor pinned to a single value by an equality filter.
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

/**
 * Two deterministic follow-up chips for a composed answer (no LLM): widen (drop the most-selective
 * filter) and pivot (swap to an unused dimension). Generic time / exploration chips backfill so a slice
 * with nothing to widen or no free dimension still yields exactly two distinct chips.
 */
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

/**
 * Build the single `data-insight` part for an answer: the code-derived verdict + designated visual +
 * the rows + follow-up chips + meta. Returned value is validated against the STRICT shared schema, so
 * an invalid shape fails loudly here (a test) rather than at persist/render time.
 */
/**
 * Assemble + strict-validate a data-insight from its already-chosen visual, verdict, and follow-ups.
 * Shared by the template path (buildInsight) and the composed path (buildComposedInsight) so the meta
 * threading (incl. the AC-3 openSet flag) and the chart/table discrimination have ONE home.
 */
function assembleInsight(
  id: string,
  visual: ChartType | "table",
  verdict: string,
  followups: string[],
  result: QueryResult,
): DataInsight {
  // openSet threads through only when the predicate applied (AC-3); absent = full history, never injected.
  // currency threads through only for a salary aggregate (018 strand 3), so the source line + table can
  // disclose the base and format the real currency instead of a hardcoded "$".
  const meta = {
    sql: result.sql,
    sampleN: result.meta.sampleN,
    updatedAt: result.meta.freshestAt,
    ...(result.meta.openSet ? { openSet: true } : {}),
    ...(result.meta.currency ? { currency: result.meta.currency } : {}),
  };
  // A chart's group labels are coalesced (a null/empty city or level reads as "unspecified", never a
  // bare null in the axis); a table keeps its cells verbatim (DataTable renders a null cell as "-").
  const data = (visual === "table" ? result.rows : coalesceSeriesLabels(result.rows)) as DataPoint[];
  const candidate =
    visual === "table"
      ? { id, kind: "table" as const, verdict, rows: data, followups, meta }
      : { id, kind: "chart" as const, chartType: visual, verdict, series: data, followups, meta };
  return DataInsightSchema.parse(candidate);
}

/** Replace null/empty values in a chart's LABEL columns (any column that holds a string somewhere) with
 *  "unspecified", so a missing group label never renders as a blank/null axis tick. Numeric measure
 *  columns are never touched. */
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
  // The pinned template visual, corrected for signal quality (018 strand 3): a trend with too few points
  // becomes a table; a pinned donut (share_split) that is not a readable true whole becomes bars.
  let visual = chartTypeFor(tool);
  if (visual === "trend" && rows.length < MIN_TREND_POINTS) visual = "table";
  if (visual === "donut" && !donutIsWhole(rows.length, sumCount(rows), sampleN)) visual = "bars";
  return assembleInsight(id, visual, verdictFor(tool, rows, params, sampleN), FOLLOWUPS[tool], result);
}

export interface BuildComposedInsightArgs {
  id: string;
  params: ComposedShape;
  /** The SERVED chart type (already shape-corrected via chartTypeForShape). */
  chartType: ChartType | "table";
  result: QueryResult;
}

/**
 * Build the single data-insight for a query_postings answer: the generic composed verdict + the served
 * chart type + the rows + deterministic follow-ups + meta. The parallel of buildInsight for the seventh
 * tool - it does NOT go through the TemplateName-keyed maps, so no faked template entry is required.
 */
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

/** The loading part written first (same id as the filled insight, so the UI reconciles in place). */
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

/** The composed tool's loading skeleton, built from the agent's chartType pick (known at call time). */
export function buildComposedSkeleton(id: string, chartType: ChartType | "table"): SkeletonPart {
  return skeletonFor(id, chartType);
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
export function emptyModelOutput(tool: string): { empty: true; tool: string; note: string } {
  return {
    empty: true,
    tool,
    note: "No postings matched this query - there is nothing to chart. Answer in plain prose (at most two sentences) that there is no matching data yet; do not invent numbers and do not describe the tool call.",
  };
}

/** The entity labels of a result: the first string column's values (companies/cities/titles/levels),
 *  capped so the model view stays lean. Grounds the model's tool-loop reasoning (chips, follow-ups) in
 *  the entities it actually got back - the prompt forbids naming any entity absent from this list. */
const MODEL_LABEL_CAP = 12;
function rowLabels(rows: DataPoint[]): string[] {
  const first = rows[0];
  if (!first) return [];
  // The label column is the first non-numeric column (a measure is always a number); detect it by "not
  // a number" rather than "is a string" so a null/empty first label still resolves to its column.
  const key = Object.keys(first).find((k) => typeof first[k] !== "number");
  if (!key) return [];
  return rows.slice(0, MODEL_LABEL_CAP).map((r) => labelText(r[key]));
}

/** A compact view for the model - the verdict + counts + row LABELS (never the full rows), so its
 *  tool-loop reasoning is grounded in the real entities without bloating context (018 strand 2). */
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

/**
 * The error part (AC-10). `system` = a tool/infra failure ("something went wrong on my side");
 * `unanswerable` = a question the data cannot answer. The user-facing copy lives in the UI (005/006);
 * the agent only tags the kind so retry/copy can branch. `ErrorKind` is defined in `@shared/insight`.
 */
export function errorPart(id: string, kind: ErrorKind): ErrorPart {
  return { type: "data-error", id, data: { kind } };
}

export interface RefusalPart {
  type: "data-refusal";
  id: string;
  data: { reason: RefusalReason };
}

/**
 * The refusal part (AC-15 cap / AC-20 daily budget, plus `too_long` for an over-length turn), streamed
 * by the agent-side backstop when a turn is refused before the model. A DISTINCT taxonomy from
 * `data-error`: not a failure, but a polite limit - the client renders it like the server action's
 * typed refusal, not the error card. `RefusalReason` is defined in `@shared/insight`.
 */
export function refusalPart(id: string, reason: RefusalReason): RefusalPart {
  return { type: "data-refusal", id, data: { reason } };
}

/** A model-input message: role + text content - the alternating history the model replays each turn. */
export type ModelMessage = { role: MessageRole; content: string };

/** The text the MODEL sees for a persisted turn (F8, prose rule one home each): for an assistant CARD
 *  turn the code-derived VERDICT read off the persisted card (the honest headline, never the model's own
 *  possibly-fabricated prose), or "" when the card carries no verdict (an error/refusal card - the card
 *  itself is the surface); a user turn or a card-less assistant turn keeps its stored content verbatim. */
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
 * F8: the model-facing content is derived per turn (`modelFacingContent`) - a card turn contributes its
 * code-derived VERDICT (the card payload is a UI artifact; the honest headline is what the model should
 * see, never the model's own prose), an error/refusal card contributes "", and a plain turn its verbatim
 * text. Empty-derived rows are then dropped so an errored/refused turn never emits an invalid empty model
 * message.
 *
 * Dropping an empty error/refusal row can leave two SAME-ROLE rows adjacent - e.g. an errored turn
 * between two user questions rebuilds as user,user - which Bedrock's strict role-alternation rejects
 * (018 review-fix). So after the empty-drop, consecutive same-role rows are COALESCED into one (their
 * text joined). This heals only the rebuilt model input; persistence is untouched, so no schema/migration
 * change - and a normally-alternating history is unaffected.
 */
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
