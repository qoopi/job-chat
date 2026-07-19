import { describe, expect, it } from "vitest";
import { buildTemplateSql } from "@shared/analytics";

describe("buildTemplateSql", () => {
  it("interpolates salary_compare cities + role and uses quantileExact over FINAL", () => {
    const { sql } = buildTemplateSql(
      "salary_compare",
      { role: "Engineer", cities: ["San Francisco", "Los Angeles"] },
      "postings",
    );
    expect(sql).toContain("FROM postings FINAL");
    expect(sql).toContain("city IN ('San Francisco', 'Los Angeles')");
    expect(sql).toContain("title ILIKE '%Engineer%'");
    expect(sql).toContain("quantileExact(0.5)");
  });

  it("maps share_split dimension to a fixed column name, never an interpolated string", () => {
    expect(buildTemplateSql("share_split", { dimension: "experience" }, "postings").sql).toContain(
      "toString(experience_level) AS label",
    );
    expect(
      buildTemplateSql("share_split", { dimension: "location_kind" }, "postings").sql,
    ).toContain("toString(location_kind) AS label");
  });

  it("anchors postings_trend to the data's max published_at (deterministic, not now())", () => {
    const { sql } = buildTemplateSql("postings_trend", { days: 7 }, "postings");
    expect(sql).toContain("(SELECT max(published_at) FROM postings FINAL) - INTERVAL 7 DAY");
    expect(sql).not.toContain("now()");
  });

  it("escapes a single quote in a free-text param (no SQL-literal break-out)", () => {
    const { sql } = buildTemplateSql("latest_postings", { company: "O'Brien" }, "postings");
    expect(sql).toContain("company ILIKE '%O\\'Brien%'");
  });

  it("rejects invalid params via Zod at the boundary", () => {
    expect(() => buildTemplateSql("salary_compare", { cities: ["SF"] }, "postings")).toThrow(); // needs 2
    expect(() => buildTemplateSql("postings_trend", { days: 0 }, "postings")).toThrow(); // positive
    expect(() => buildTemplateSql("share_split", { dimension: "employment" }, "postings")).toThrow(); // dropped
    expect(() => buildTemplateSql("latest_postings", { limit: 1000 }, "postings")).toThrow(); // max 100
    expect(() => buildTemplateSql("salary_distribution", { bogus: 1 }, "postings")).toThrow(); // strict
  });

  it("defaults latest_postings limit to 20 and honors the injected table name", () => {
    expect(buildTemplateSql("latest_postings", {}, "postings").sql).toContain("LIMIT 20");
    expect(buildTemplateSql("top_companies", {}, "postings_test").sql).toContain(
      "FROM postings_test FINAL",
    );
  });
});
