import { describe, expect, it, vi } from "vitest";
import type { Analytics } from "@shared/analytics";
import { buildCatalogTools, CATALOG_TOOL_NAMES } from "../../trigger/tools";
import type { EmitPart } from "../../trigger/tools";

const opts = { toolCallId: "call-1", messages: [] } as unknown as Parameters<
  NonNullable<ReturnType<typeof buildCatalogTools>["salary_distribution"]["execute"]>
>[1];

describe("buildCatalogTools", () => {
  it("exposes the 6 catalog tools plus the unanswerable escape hatch", () => {
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: () => {} });
    for (const name of CATALOG_TOOL_NAMES) expect(tools).toHaveProperty(name);
    expect(tools).toHaveProperty("report_unanswerable");
  });

  it("emits a loading skeleton then the filled insight, and hands the model a compact view", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(async () => ({
        sql: "SELECT 1",
        rows: [{ company: "Google", count: 4 }],
        meta: { sampleN: 10, freshestAt: "2026-07-18 06:00:00" },
      })),
      runComposedQuery: vi.fn(),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });
    const out = await tools.top_companies.execute!({}, opts);

    expect(emitted[0]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "loading" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1" });
    expect((out as { verdict: string }).verdict).toContain("Google");
  });

  // P1 polish: a 0-row result emits NO card. The tool clears its loading skeleton with an empty marker
  // (same id -> supersedes the skeleton in place, no dangling card) and hands the model a plain-mode
  // signal so the answer is plain prose, not an empty "No data" insight card.
  it("emits an empty marker (no filled card) and a plain-mode output when the query returns no rows", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(async () => ({
        sql: "SELECT 1",
        rows: [],
        meta: { sampleN: 0, freshestAt: "1970-01-01 00:00:00" },
      })),
      runComposedQuery: vi.fn(),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });
    const out = await tools.salary_distribution.execute!({ city: "SF" }, opts);

    expect(emitted[0]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "loading" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "empty" } });
    // No filled insight (no verdict/series/rows) was ever emitted for the empty result.
    expect(emitted.some((p) => p.type === "data-insight" && (p.data as { verdict?: unknown }).verdict !== undefined)).toBe(false);
    expect((out as { empty?: boolean }).empty).toBe(true);
  });

  // AC-10: a tool/infra failure is taxonomized as a `system` error part, and the tool does NOT throw
  // (the agent keeps control to apologize) - it hands the model a compact error marker.
  it("emits a system error part when the query fails, without throwing", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(async () => {
        throw new Error("ClickHouse unreachable");
      }),
      runComposedQuery: vi.fn(),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });
    const out = await tools.salary_distribution.execute!({ city: "SF" }, opts);

    expect(emitted.some((p) => p.type === "data-error" && p.data.kind === "system")).toBe(true);
    expect((out as { error: string }).error).toBeTruthy();
  });

  // AC-10: the unanswerable path is a distinct kind for the UI's distinct copy.
  it("report_unanswerable emits an unanswerable error part", async () => {
    const emitted: EmitPart[] = [];
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: (p) => emitted.push(p) });
    await tools.report_unanswerable.execute!({ reason: "outside the postings data" }, opts);

    expect(emitted.some((p) => p.type === "data-error" && p.data.kind === "unanswerable")).toBe(true);
  });
});

// The seventh tool: a composed aggregate with an agent-chosen chartType behind the deterministic
// fallback. It runs the composed path (analytics.runComposedQuery), not a template.
describe("buildCatalogTools query_postings (composed tool, AC-1/AC-3/AC-4)", () => {
  function composedAnalytics(rows: Record<string, unknown>[], openSet = true): Analytics {
    return {
      runQuery: vi.fn(),
      runComposedQuery: vi.fn(async () => ({
        sql: "SELECT company, count() AS count FROM postings FINAL WHERE country = 'United States'",
        rows,
        meta: { sampleN: rows.reduce((s, r) => s + Number(r.count ?? 1), 0), freshestAt: "2026-07-18 06:00:00", ...(openSet ? { openSet: true } : {}) },
      })),
    };
  }

  it("is registered alongside the six templates", () => {
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: () => {} });
    expect(tools).toHaveProperty("query_postings");
  });

  it("emits a skeleton from the RAW chart pick, then the filled composed insight (same id), and strips chartType from the query params", async () => {
    const emitted: EmitPart[] = [];
    const analytics = composedAnalytics([
      { company: "Google", count: 4 },
      { company: "Meta", count: 2 },
    ]);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], country: "United States", chartType: "bars" },
      opts,
    );

    // Skeleton first (loading, carries the raw pick), filled insight last (same id).
    expect(emitted[0]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "loading", chartType: "bars" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1" });
    const filled = emitted[emitted.length - 1].data as { verdict?: string; chartType?: string };
    expect(filled.verdict).toContain("Google");
    expect(filled.chartType).toBe("bars");

    // The composed schema is strict, so the chartType field must be stripped before runComposedQuery.
    const arg = (analytics.runComposedQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).not.toHaveProperty("chartType");
    expect(arg).toMatchObject({ measures: ["count"], dimensions: ["company"], country: "United States" });

    // The RAW pick is recorded on the tool result (the 010 harness measurement surface, AC-4).
    expect((out as { rawChartType?: string }).rawChartType).toBe("bars");
  });

  it("records the raw pick but serves a shape-fit chart when the pick is unfit (donut over > 6 slices -> bars)", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ company: `C${i}`, count: 8 - i }));
    const emitted: EmitPart[] = [];
    const analytics = composedAnalytics(rows);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], chartType: "donut" },
      opts,
    );

    const filled = emitted[emitted.length - 1].data as { chartType?: string };
    expect(filled.chartType).toBe("bars"); // served type corrected
    expect((out as { rawChartType?: string; visual?: string }).rawChartType).toBe("donut"); // raw pick recorded
    expect((out as { visual?: string }).visual).toBe("bars"); // served type in the model view
  });

  it("emits an empty marker (no card) and a plain-mode output when the composed query returns no rows", async () => {
    const emitted: EmitPart[] = [];
    const analytics = composedAnalytics([]);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], country: "Atlantis", chartType: "bars" },
      opts,
    );

    expect(emitted[0]).toMatchObject({ data: { status: "loading" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "empty" } });
    expect(emitted.some((p) => p.type === "data-insight" && (p.data as { verdict?: unknown }).verdict !== undefined)).toBe(false);
    expect((out as { empty?: boolean }).empty).toBe(true);
  });

  it("taxonomizes a composed query failure as a system error without throwing", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(),
      runComposedQuery: vi.fn(async () => {
        throw new Error("ClickHouse unreachable");
      }),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], chartType: "bars" },
      opts,
    );

    expect(emitted.some((p) => p.type === "data-error" && p.data.kind === "system")).toBe(true);
    expect((out as { error?: string }).error).toBeTruthy();
  });
});
