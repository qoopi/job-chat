import { describe, expect, it } from "vitest";
import { DataInsightSchema } from "@shared/insight";
import type { QueryResult } from "@shared/analytics";
import {
  buildInsight,
  buildSkeleton,
  chartTypeFor,
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
});

describe("buildSkeleton is the loading part written before the tool returns", () => {
  it("carries the visual and a loading state, no rows", () => {
    const skel = buildSkeleton("m1", "salary_distribution");
    expect(skel).toMatchObject({ id: "m1", kind: "chart", chartType: "histogram", status: "loading" });
    const table = buildSkeleton("m6", "latest_postings");
    expect(table).toMatchObject({ id: "m6", kind: "table", status: "loading" });
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
