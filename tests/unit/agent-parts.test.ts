import { describe, expect, it } from "vitest";
import { DataInsightSchema } from "@shared/insight";
import type { QueryResult } from "@shared/analytics";
import {
  buildComposedInsight,
  buildComposedSkeleton,
  buildInsight,
  buildSkeleton,
  chartTypeFor,
  chartTypeForShape,
  composedFollowups,
  emptyModelOutput,
  emptyPart,
  errorPart,
  extractAssistantPersistence,
  refusalPart,
  toModelOutput,
} from "../../trigger/parts";

// Synthetic query results mirroring the AC-11 fixture's hand-computed rows (tests/fixtures), so the
// pure part-building is unit-testable without a ClickHouse client. The live 7/7 run lives in the
// integration suite.
function result(rows: Record<string, unknown>[], sampleN: number): QueryResult {
  return { sql: "SELECT 1", rows, meta: { sampleN, freshestAt: "2026-07-18 06:00:00" } };
}

describe("chartTypeFor maps each catalog tool to its designated visual (AC-11)", () => {
  it("pins the visuals from the brief case table", () => {
    expect(chartTypeFor("salary_distribution")).toBe("histogram");
    expect(chartTypeFor("salary_compare")).toBe("bars");
    expect(chartTypeFor("postings_trend")).toBe("trend");
    expect(chartTypeFor("top_companies")).toBe("bars");
    expect(chartTypeFor("share_split")).toBe("donut");
    expect(chartTypeFor("latest_postings")).toBe("table");
  });
});

describe("buildInsight produces a strict-valid data-insight with the headline value in the verdict", () => {
  it("salary_distribution -> histogram, median in the verdict", () => {
    const r = result(
      [
        { bucket: 160000, count: 1, median: 180000 },
        { bucket: 180000, count: 1, median: 180000 },
        { bucket: 200000, count: 1, median: 180000 },
      ],
      3,
    );
    const insight = buildInsight({ id: "m1", tool: "salary_distribution", params: {}, result: r });
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
    expect(insight.kind).toBe("chart");
    if (insight.kind === "chart") expect(insight.chartType).toBe("histogram");
    expect(insight.verdict).toContain("180000");
    expect(insight.meta).toEqual({ sql: "SELECT 1", sampleN: 3, updatedAt: "2026-07-18 06:00:00" });
  });

  it("salary_compare -> bars, winning city + median in the verdict", () => {
    const r = result(
      [
        { city: "San Francisco", median: 180000, n: 3 },
        { city: "Los Angeles", median: 140000, n: 3 },
      ],
      6,
    );
    const insight = buildInsight({ id: "m2", tool: "salary_compare", params: {}, result: r });
    expect(insight.verdict).toContain("San Francisco");
    expect(insight.verdict).toContain("180000");
    if (insight.kind === "chart") expect(insight.chartType).toBe("bars");
  });

  // Honesty nit: with only one city row (the other city had no salaried postings) there was no
  // comparison, so the verdict must NOT claim one city "pays more" than an absent other.
  it("salary_compare stays honest on a single city row - no false 'pays more' comparison", () => {
    const r = result([{ city: "San Francisco", median: 180000, n: 3 }], 3);
    const insight = buildInsight({ id: "m2b", tool: "salary_compare", params: {}, result: r });
    expect(insight.verdict).not.toContain("pays more");
    expect(insight.verdict).toContain("San Francisco");
    expect(insight.verdict).toContain("180000");
  });

  it("postings_trend -> trend, total count in the verdict", () => {
    const r = result(
      [
        { day: "2026-07-16", count: 2 },
        { day: "2026-07-17", count: 2 },
        { day: "2026-07-18", count: 6 },
      ],
      10,
    );
    const insight = buildInsight({ id: "m3", tool: "postings_trend", params: { days: 7 }, result: r });
    expect(insight.verdict).toContain("10");
    if (insight.kind === "chart") expect(insight.chartType).toBe("trend");
  });

  it("top_companies -> bars, top company + count in the verdict", () => {
    const r = result([{ company: "Google", count: 4 }, { company: "Meta", count: 2 }], 10);
    const insight = buildInsight({ id: "m4", tool: "top_companies", params: {}, result: r });
    expect(insight.verdict).toContain("Google");
    expect(insight.verdict).toContain("4");
  });

  it("share_split -> donut, dominant label + count in the verdict", () => {
    const r = result([{ label: "Senior", count: 5 }, { label: "Junior", count: 3 }, { label: "Staff", count: 2 }], 10);
    const insight = buildInsight({ id: "m5", tool: "share_split", params: { dimension: "experience" }, result: r });
    expect(insight.verdict).toContain("Senior");
    expect(insight.verdict).toContain("5");
    if (insight.kind === "chart") expect(insight.chartType).toBe("donut");
  });

  it("latest_postings -> table (kind table, no chartType), count + latest title in the verdict", () => {
    const r = result(
      [
        { title: "Senior Software Engineer", company: "Google" },
        { title: "Data Scientist", company: "Google" },
        { title: "Senior Engineer", company: "Google" },
      ],
      3,
    );
    const insight = buildInsight({ id: "m6", tool: "latest_postings", params: {}, result: r });
    expect(insight.kind).toBe("table");
    expect(insight.verdict).toContain("3");
    expect(insight.verdict).toContain("Senior Software Engineer");
  });

  it("stays honest on empty results - a no-data verdict, still strict-valid", () => {
    const insight = buildInsight({ id: "m7", tool: "salary_distribution", params: {}, result: result([], 0) });
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
    if (insight.kind === "chart") expect(insight.series).toEqual([]);
  });

  // AC-3: the open-set flag threads from the analytics result through buildInsight into the insight
  // meta, so InsightCard can render "N open postings" for a current-state read.
  it("carries the openSet flag into the insight meta for a current-state result", () => {
    const r: QueryResult = {
      sql: "SELECT 1",
      rows: [{ company: "Google", count: 4 }],
      meta: { sampleN: 10, freshestAt: "2026-07-18 06:00:00", openSet: true },
    };
    const insight = buildInsight({ id: "os1", tool: "top_companies", params: {}, result: r });
    expect(insight.meta.openSet).toBe(true);
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
  });

  // A full-history result has no openSet on its meta - buildInsight must NOT default-inject the key
  // (optionality is the compatibility contract for old persisted payloads).
  it("omits openSet from the insight meta for a full-history result", () => {
    const insight = buildInsight({
      id: "os2",
      tool: "postings_trend",
      params: { days: 7 },
      result: result([{ day: "2026-07-18", count: 3 }], 3),
    });
    expect(insight.meta).not.toHaveProperty("openSet");
  });
});

describe("buildSkeleton is the loading part written before the tool returns", () => {
  it("carries the visual and a loading state, no rows", () => {
    const skel = buildSkeleton("m1", "salary_distribution");
    expect(skel).toMatchObject({ id: "m1", kind: "chart", chartType: "histogram", status: "loading" });
    const table = buildSkeleton("m6", "latest_postings");
    expect(table).toMatchObject({ id: "m6", kind: "table", status: "loading" });
  });
});

describe("emptyPart clears a tool's skeleton on a 0-row result (empty = plain mode, no card)", () => {
  it("supersedes the skeleton in place and carries no insight payload", () => {
    const part = emptyPart("call-1");
    expect(part).toEqual({ type: "data-insight", id: "call-1", data: { status: "empty" } });
    // It must NOT classify as a valid insight (would render an empty card) ...
    expect(DataInsightSchema.safeParse(part.data).success).toBe(false);
    // ... nor as the loading skeleton (would render a stuck spinner).
    expect((part.data as { status: string }).status).not.toBe("loading");
  });

  it("emptyModelOutput signals the model to answer in plain prose, not a chart", () => {
    const out = emptyModelOutput("salary_distribution");
    expect(out.empty).toBe(true);
    expect(out.note.toLowerCase()).toContain("plain");
  });
});

describe("toModelOutput is compact - the model sees the verdict, not the raw rows", () => {
  it("returns the verdict, sample size, and row count only", () => {
    const r = result([{ company: "Google", count: 4 }], 10);
    const insight = buildInsight({ id: "m4", tool: "top_companies", params: {}, result: r });
    const out = toModelOutput(insight);
    expect(out.verdict).toBe(insight.verdict);
    expect(out.sampleN).toBe(10);
    expect(out).not.toHaveProperty("series");
  });
});

describe("errorPart carries the taxonomy kind for the UI to copy (AC-10)", () => {
  it("emits system vs unanswerable kinds", () => {
    expect(errorPart("m1", "system")).toEqual({ type: "data-error", id: "m1", data: { kind: "system" } });
    expect(errorPart("m1", "unanswerable")).toEqual({
      type: "data-error",
      id: "m1",
      data: { kind: "unanswerable" },
    });
  });
});

describe("refusalPart carries the guard reason for the UI to render like an action refusal (AC-15/AC-20)", () => {
  it("emits guest_cap vs daily_budget reasons on a distinct data-refusal part", () => {
    expect(refusalPart("m1", "guest_cap")).toEqual({
      type: "data-refusal",
      id: "m1",
      data: { reason: "guest_cap" },
    });
    expect(refusalPart("m1", "daily_budget")).toEqual({
      type: "data-refusal",
      id: "m1",
      data: { reason: "daily_budget" },
    });
  });

  // The input-size backstop reuses the same data-refusal part so an over-length turn refused at the
  // agent-run ingress renders as a polite notice, identically to a cap/budget refusal.
  it("emits the too_long reason on the same data-refusal part", () => {
    expect(refusalPart("m1", "too_long")).toEqual({
      type: "data-refusal",
      id: "m1",
      data: { reason: "too_long" },
    });
  });
});

describe("extractAssistantPersistence pulls the persisted content + card payload (AC-13)", () => {
  it("joins text parts and keeps the single data-insight payload", () => {
    const insight = buildInsight({
      id: "i1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "Here is what I found." },
        { type: "data-insight", id: "i1", data: insight },
      ],
    };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("Here is what I found.");
    expect(parts).toEqual(insight);
  });

  it("keeps only the final (filled) part when a skeleton shares its id", () => {
    const insight = buildInsight({
      id: "i1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const message = {
      role: "assistant",
      parts: [
        { type: "data-insight", id: "i1", data: buildSkeleton("i1", "top_companies") },
        { type: "data-insight", id: "i1", data: insight },
      ],
    };
    const { parts } = extractAssistantPersistence(message);
    expect(parts).toEqual(insight);
  });

  it("returns null parts for a plain (text-only) answer", () => {
    const message = { role: "assistant", parts: [{ type: "text", text: "Two words." }] };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("Two words.");
    expect(parts).toBeNull();
  });

  // AC-10/AC-13 regression: on a tool failure the tool emits a loading skeleton then a data-error
  // under the SAME id. The persisted card must be the ERROR marker, never the stuck loading skeleton
  // (which would resume as a spinner that never resolves and lose the error).
  it("persists the error marker, not the loading skeleton, when a tool fails", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "salary_distribution") },
        { type: "data-error", id: "call-1", data: { kind: "system" } },
      ],
    };
    const { parts } = extractAssistantPersistence(message);
    expect(parts).toEqual({ kind: "system" });
  });

  // Defensive: a skeleton that was never superseded (neither filled nor errored) is dropped rather
  // than persisted, so resume never restores a stuck spinner.
  it("drops an orphan loading skeleton rather than persisting it", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "data-insight", id: "x", data: buildSkeleton("x", "top_companies") }],
    };
    expect(extractAssistantPersistence(message).parts).toBeNull();
  });

  // P1 polish: a 0-row tool result emits a skeleton then an empty marker under the same id. The empty
  // marker supersedes the skeleton and is NOT persistable, so the turn persists no card (plain-prose
  // answer) - never a stuck skeleton nor an empty "No data" card.
  it("drops a skeleton superseded by an empty marker - the empty turn persists no card", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "I could not find any matching postings." },
        { type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "salary_distribution") },
        { type: "data-insight", id: "call-1", data: emptyPart("call-1").data },
      ],
    };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("I could not find any matching postings.");
    expect(parts).toBeNull();
  });

  // The one-part-per-answer invariant across an internal retry: a first tool call that matched nothing
  // (skeleton -> empty) followed by a retry that landed rows (skeleton -> insight) persists EXACTLY the
  // one filled insight - the empty first attempt leaves no dangling card.
  it("keeps only the filled insight when an empty attempt precedes a successful retry", () => {
    const insight = buildInsight({
      id: "call-2",
      tool: "salary_distribution",
      params: {},
      result: result([{ bucket: 160000, count: 3, median: 180000 }], 3),
    });
    const message = {
      role: "assistant",
      parts: [
        { type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "salary_distribution") },
        { type: "data-insight", id: "call-1", data: emptyPart("call-1").data },
        { type: "data-insight", id: "call-2", data: buildSkeleton("call-2", "salary_distribution") },
        { type: "data-insight", id: "call-2", data: insight },
      ],
    };
    const { parts } = extractAssistantPersistence(message);
    expect(parts).toEqual(insight);
  });

  // A guard refusal (cap/budget) streamed by the agent backstop persists as its marker, so a returning
  // guest still sees the polite limit notice rather than an empty assistant turn.
  it("persists a refusal marker from the agent backstop", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "data-refusal", id: "r1", data: { reason: "guest_cap" } }],
    };
    expect(extractAssistantPersistence(message).parts).toEqual({ reason: "guest_cap" });
  });

  it("persists the too_long refusal marker so the notice survives resume", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "data-refusal", id: "r1", data: { reason: "too_long" } }],
    };
    expect(extractAssistantPersistence(message).parts).toEqual({ reason: "too_long" });
  });
});

// ---- query_postings composed path (parallel to the TemplateName-keyed template path) --------------

// AC-4: chartTypeForShape is the deterministic server-side fallback. The agent proposes a chartType
// (the RAW pick, recorded by the tool); this returns the SERVED type - the agent's pick when it fits
// the data shape, else the shape's fit type. Case table + override behavior.
describe("Should_FallBackToFitChartType_When_RawPickUnfit (chartTypeForShape, AC-4)", () => {
  it("a time bucket is always a trend (any non-trend pick is overridden)", () => {
    expect(chartTypeForShape({ dimensions: [], bucket: "week" }, "bars", 5)).toBe("trend");
    expect(chartTypeForShape({ dimensions: [], bucket: "day" }, "donut", 3)).toBe("trend");
    expect(chartTypeForShape({ dimensions: [], bucket: "month" }, "trend", 12)).toBe("trend");
  });

  it("a single categorical dimension + count is bars by default", () => {
    expect(chartTypeForShape({ dimensions: ["company"] }, "bars", 10)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["title"] }, "bars", 20)).toBe("bars");
  });

  it("honors a donut pick only for a readable share-of-whole (<= 6 slices)", () => {
    expect(chartTypeForShape({ dimensions: ["experience_level"] }, "donut", 4)).toBe("donut");
    expect(chartTypeForShape({ dimensions: ["location_kind"] }, "donut", 6)).toBe("donut");
    // > 6 slices: a donut is unreadable, so the unfit pick is corrected to bars.
    expect(chartTypeForShape({ dimensions: ["company"] }, "donut", 7)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["company"] }, "donut", 12)).toBe("bars");
  });

  it("corrects an unfit pick on a single-dimension shape to bars", () => {
    expect(chartTypeForShape({ dimensions: ["company"] }, "trend", 5)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["title"] }, "histogram", 5)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["company"] }, "table", 5)).toBe("bars");
  });

  it("two grouping keys (2 dims, or a dim + bucket) are an entity-ish table", () => {
    expect(chartTypeForShape({ dimensions: ["company", "city"] }, "bars", 5)).toBe("table");
    expect(chartTypeForShape({ dimensions: ["company"], bucket: "month" }, "trend", 5)).toBe("table");
  });

  it("a bare aggregate (no dimension, no bucket) is a single-row table", () => {
    expect(chartTypeForShape({ dimensions: [] }, "bars", 1)).toBe("table");
  });
});

describe("buildComposedSkeleton builds the loading part from the agent's chartType pick", () => {
  it("a chart pick -> chart skeleton with that chartType", () => {
    expect(buildComposedSkeleton("c1", "bars")).toEqual({
      id: "c1",
      kind: "chart",
      chartType: "bars",
      status: "loading",
    });
    expect(buildComposedSkeleton("c2", "donut")).toMatchObject({ kind: "chart", chartType: "donut" });
  });

  it("a table pick -> table skeleton, no chartType", () => {
    expect(buildComposedSkeleton("c3", "table")).toEqual({ id: "c3", kind: "table", status: "loading" });
  });
});

describe("buildComposedInsight builds a strict-valid insight for the seventh tool (no faked template)", () => {
  const composedResult = (
    rows: Record<string, unknown>[],
    sampleN: number,
    openSet = true,
  ): QueryResult => ({
    sql: "SELECT company, count() AS count FROM postings FINAL WHERE ...",
    rows,
    meta: { sampleN, freshestAt: "2026-07-18 06:00:00", ...(openSet ? { openSet: true } : {}) },
  });

  it("count by company (bars): leads with the top company + its count, threads meta + openSet", () => {
    const result = composedResult(
      [
        { company: "Google", count: 4 },
        { company: "Meta", count: 2 },
        { company: "Amazon", count: 2 },
      ],
      8,
    );
    const insight = buildComposedInsight({
      id: "q1",
      params: { measures: ["count"], dimensions: ["company"] },
      chartType: "bars",
      result,
    });
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
    expect(insight.kind).toBe("chart");
    if (insight.kind === "chart") {
      expect(insight.chartType).toBe("bars");
      expect(insight.series).toEqual(result.rows);
    }
    expect(insight.verdict).toContain("Google");
    expect(insight.verdict).toContain("4");
    expect(insight.meta).toMatchObject({ sampleN: 8, updatedAt: "2026-07-18 06:00:00", openSet: true });
  });

  it("a share-of-whole served as a donut is a strict-valid chart insight", () => {
    const insight = buildComposedInsight({
      id: "q2",
      params: { measures: ["count"], dimensions: ["experience_level"] },
      chartType: "donut",
      result: composedResult([{ experience_level: "Senior", count: 5 }, { experience_level: "Junior", count: 3 }], 8),
    });
    expect(insight.kind).toBe("chart");
    if (insight.kind === "chart") expect(insight.chartType).toBe("donut");
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
  });

  it("an entity-ish two-dimension result served as a table carries rows, not a series", () => {
    const insight = buildComposedInsight({
      id: "q3",
      params: { measures: ["count"], dimensions: ["company", "city"] },
      chartType: "table",
      result: composedResult([{ company: "Google", city: "San Francisco", count: 3 }], 3),
    });
    expect(insight.kind).toBe("table");
    if (insight.kind === "table") expect(insight.rows).toHaveLength(1);
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
  });

  it("a salary measure by dimension names the leader with its value", () => {
    const insight = buildComposedInsight({
      id: "q4",
      params: { measures: ["median_salary"], dimensions: ["experience_level"] },
      chartType: "bars",
      result: composedResult([{ experience_level: "Staff", median_salary: 200000 }, { experience_level: "Senior", median_salary: 175000 }], 8),
    });
    expect(insight.verdict).toContain("Staff");
    expect(insight.verdict).toContain("200000");
  });

  it("omits openSet from meta for a full-history (windowed) composed result", () => {
    const insight = buildComposedInsight({
      id: "q5",
      params: { measures: ["count"], bucket: "week", days: 30 },
      chartType: "trend",
      result: composedResult([{ bucket: "2026-07-06", count: 4 }, { bucket: "2026-07-13", count: 6 }], 10, false),
    });
    expect(insight.meta).not.toHaveProperty("openSet");
    // A trend leads with the total, the honest headline for a time series.
    expect(insight.verdict).toContain("10");
  });

  // Gap fill (05-testing audit): a bare salary aggregate (no dimension, no bucket) was untested - the
  // branch distinct from both the ranked-leader and the bucketed-range phrasing.
  it("a bare salary aggregate (no dimension, no bucket) states the single value plainly", () => {
    const insight = buildComposedInsight({
      id: "q7",
      params: { measures: ["median_salary"] },
      chartType: "table",
      result: composedResult([{ median_salary: 165000 }], 40),
    });
    expect(insight.verdict).toContain("165000");
    expect(insight.verdict.toLowerCase()).toContain("median salary");
  });

  // Gap fill (05-testing audit): a bucketed (time-series) salary measure was untested - it must report
  // the observed range, never a single leader (there is no dimension to rank by).
  it("a bucketed salary measure reports the observed range, not a leader", () => {
    const insight = buildComposedInsight({
      id: "q8",
      params: { measures: ["median_salary"], bucket: "month" },
      chartType: "trend",
      result: composedResult(
        [{ bucket: "2026-05-01", median_salary: 150000 }, { bucket: "2026-06-01", median_salary: 170000 }],
        20,
      ),
    });
    expect(insight.verdict).toContain("150000");
    expect(insight.verdict).toContain("170000");
  });

  // PRODUCTION BUG (05-testing audit, loops back to developing): verdictForComposed's `ranked` check
  // only tests whether the FIRST dimension is defined, not whether there is EXACTLY ONE - so a
  // 2-dimension cross-tab (e.g. company x city) still takes the "leader" branch and names the top ROW's
  // first-dimension value as if it led the whole breakdown. The Completion Report's own deviation (2)
  // states "a trend / cross-tab / bare aggregate leads with the total or the observed range, so no false
  // superlative is ever claimed" - the code does not match that stated design for the cross-tab case.
  // Repro: Meta's single row (6) outranks Google's individual rows (5, 3), but Google's true total across
  // both its rows (8) exceeds Meta's (6) - the verdict wrongly says "Meta leads" instead of reporting the
  // total (as the bucketed/bare-aggregate branches correctly do). This test intentionally FAILS against
  // the current code; do not patch trigger/parts.ts here (testing owns test completeness, not product
  // code) - route the fix to developing.
  it("does NOT name a false leader for a 2-dimension cross-tab (honesty: no superlative across a group-by pair)", () => {
    const insight = buildComposedInsight({
      id: "q6",
      params: { measures: ["count"], dimensions: ["company", "city"] },
      chartType: "table",
      result: composedResult(
        [
          { company: "Meta", city: "San Francisco", count: 6 },
          { company: "Google", city: "New York", count: 5 },
          { company: "Google", city: "San Francisco", count: 3 },
        ],
        14,
      ),
    });
    expect(insight.verdict).not.toContain("Meta leads");
    expect(insight.verdict).toContain("14");
  });

  // ROUND-2 REGRESSION (honesty): the agent may request an ASCENDING sort - the natural pick for
  // "which city has the FEWEST / pays the LEAST" - so the executor returns rows in ascending order and
  // rows[0] is the LOWEST, not the leader. The verdict must verify the extreme FROM the rows (never
  // assume the default measure-desc sort produced rows[0]): it must name the honest extreme (the lowest,
  // which is exactly what the user asked for) and must NEVER claim rows[0] "leads" or is "highest".
  it("count with sort dir:asc names the FEWEST, never a false 'leads' (rows[0] is the minimum)", () => {
    const insight = buildComposedInsight({
      id: "q9",
      params: { measures: ["count"], dimensions: ["city"], sort: { by: "count", dir: "asc" } },
      chartType: "bars",
      result: composedResult(
        [
          { city: "Akron", count: 1 },
          { city: "Austin", count: 40 },
          { city: "New York", count: 5000 },
        ],
        5041,
      ),
    });
    expect(insight.verdict).not.toContain("leads");
    expect(insight.verdict.toLowerCase()).not.toContain("highest");
    expect(insight.verdict).toContain("Akron"); // rows[0], the genuine minimum, is the honest headline
    expect(insight.verdict.toLowerCase()).toContain("fewest");
    expect(insight.verdict).not.toContain("New York"); // the real max is NOT named as the leader
  });

  it("a salary measure with sort dir:asc names the LOWEST, never a false 'highest'", () => {
    const insight = buildComposedInsight({
      id: "q10",
      params: {
        measures: ["median_salary"],
        dimensions: ["city"],
        sort: { by: "median_salary", dir: "asc" },
      },
      chartType: "bars",
      result: composedResult(
        [
          { city: "Detroit", median_salary: 60000 },
          { city: "Austin", median_salary: 130000 },
          { city: "San Francisco", median_salary: 220000 },
        ],
        30,
      ),
    });
    expect(insight.verdict.toLowerCase()).not.toContain("highest");
    expect(insight.verdict).not.toContain("leads");
    expect(insight.verdict).toContain("Detroit"); // rows[0], the genuine minimum
    expect(insight.verdict.toLowerCase()).toContain("lowest");
    expect(insight.verdict).toContain("60000");
    expect(insight.verdict).not.toContain("San Francisco"); // the real max is NOT named as the leader
  });
});

describe("composedFollowups derives two deterministic chips from the params (no LLM)", () => {
  it("widens by dropping the most-selective filter and pivots to an unused dimension", () => {
    const chips = composedFollowups({ measures: ["count"], dimensions: ["company"], country: "United States" });
    expect(chips).toHaveLength(2);
    expect(chips[0]).toBe("How does this look worldwide?"); // drop the country filter
    expect(chips[1]).toBe("Break this down by experience level."); // an unused, unpinned dimension
  });

  it("respects the most-selective precedence (role beats company beats country)", () => {
    const chips = composedFollowups({
      measures: ["count"],
      dimensions: ["city"],
      role: "engineer",
      company: "Google",
      country: "United States",
    });
    expect(chips[0]).toBe("How does this look across all roles?");
  });

  it("falls back to a time pivot when there is no filter to widen, and stays at two chips", () => {
    const chips = composedFollowups({ measures: ["count"], dimensions: ["title"] });
    expect(chips).toHaveLength(2);
    expect(chips).toContain("How has this changed over time?");
  });

  it("is deterministic - the same params yield the same chips", () => {
    const params = { measures: ["median_salary"], dimensions: ["experience_level"], city: "Berlin" };
    expect(composedFollowups(params)).toEqual(composedFollowups(params));
  });
});
