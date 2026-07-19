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
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });
    const out = await tools.top_companies.execute!({}, opts);

    expect(emitted[0]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "loading" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1" });
    expect((out as { verdict: string }).verdict).toContain("Google");
  });

  // AC-10: a tool/infra failure is taxonomized as a `system` error part, and the tool does NOT throw
  // (the agent keeps control to apologize) - it hands the model a compact error marker.
  it("emits a system error part when the query fails, without throwing", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(async () => {
        throw new Error("ClickHouse unreachable");
      }),
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
