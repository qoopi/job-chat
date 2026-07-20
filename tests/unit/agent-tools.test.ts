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
