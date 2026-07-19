import { describe, expect, it } from "vitest";
import { CHART_TYPES, DataInsightSchema } from "@shared/insight";

const meta = { sql: "SELECT 1", sampleN: 42, updatedAt: "2026-07-18 06:00:00" };

describe("DataInsightSchema (the data-insight part)", () => {
  it("accepts a chart insight with a chartType and series", () => {
    const part = {
      id: "abc",
      kind: "chart",
      chartType: "histogram",
      verdict: "The median salary is $180k.",
      series: [{ bucket: 160000, count: 1 }],
      followups: ["Compare to LA", "Show senior only"],
      meta,
    };
    const parsed = DataInsightSchema.parse(part);
    expect(parsed.kind).toBe("chart");
  });

  it("accepts a table insight with rows and no chartType", () => {
    const part = {
      id: "t1",
      kind: "table",
      verdict: "3 recent senior roles.",
      rows: [{ title: "Staff Engineer", company: "Meta", salary_min: null }],
      followups: [],
      meta,
    };
    const parsed = DataInsightSchema.parse(part);
    expect(parsed.kind).toBe("table");
  });

  it("rejects a chart insight missing its chartType (invalid state defined away)", () => {
    const bad = { id: "x", kind: "chart", verdict: "v", series: [], followups: [], meta };
    expect(DataInsightSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown chartType", () => {
    const bad = {
      id: "x",
      kind: "chart",
      chartType: "pie",
      verdict: "v",
      series: [],
      followups: [],
      meta,
    };
    expect(DataInsightSchema.safeParse(bad).success).toBe(false);
  });

  it("exposes the four chart primitives (table is a separate kind)", () => {
    expect([...CHART_TYPES]).toEqual(["trend", "bars", "histogram", "donut"]);
  });

  it("rejects an unknown extra key on a variant (strict: reject a mis-shaped writer payload)", () => {
    const bad = {
      id: "x",
      kind: "table",
      verdict: "v",
      rows: [],
      followups: [],
      meta,
      extra: "nope", // not stripped silently - rejected at the boundary
    };
    expect(DataInsightSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown extra key inside meta (strict)", () => {
    const bad = {
      id: "x",
      kind: "table",
      verdict: "v",
      rows: [],
      followups: [],
      meta: { ...meta, extra: "nope" },
    };
    expect(DataInsightSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a part whose meta lacks the sql (Show query needs the executed SQL)", () => {
    const bad = {
      id: "x",
      kind: "table",
      verdict: "v",
      rows: [],
      followups: [],
      meta: { sampleN: 1, updatedAt: "t" },
    };
    expect(DataInsightSchema.safeParse(bad).success).toBe(false);
  });
});
