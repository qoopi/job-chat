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

  // A param with no quote at all does not exercise the backslash-escaping step (chStr's first
  // regex), so it cannot catch that step being dropped - "O'Brien" round-trips identically whether
  // or not backslashes are escaped, since it contains none. These three cases fill that gap: a raw
  // backslash, a backslash immediately before the closing quote (the classic "eats the quote"
  // break-out), and a combined quote+backslash break-out attempt.
  it("escapes a literal backslash in a free-text param (not silently dropped or left bare)", () => {
    const { sql } = buildTemplateSql("latest_postings", { company: "back\\slash" }, "postings");
    // one input backslash -> one escaped ('\\') backslash in the CH literal.
    expect(sql).toContain("company ILIKE '%back\\\\slash%'");
  });

  it("escapes a trailing backslash so it cannot swallow the closing quote", () => {
    // `company`/`role` are wrapped as `%...%` before escaping, so a trailing backslash there always
    // has a literal `%` between it and the closing quote - not the adjacency this bug needs. `city`
    // is escaped bare (`city = ${chStr(p.city)}`), so a trailing backslash sits immediately before
    // the quote chStr appends: the exact position where an unescaped backslash would swallow it.
    const { sql } = buildTemplateSql("salary_distribution", { city: "trail\\" }, "postings");
    expect(sql).toContain("city = 'trail\\\\'");
  });

  it("neutralizes a quote+backslash break-out attempt as a single escaped literal", () => {
    const { sql } = buildTemplateSql(
      "latest_postings",
      { company: "x' OR '1'='1" },
      "postings",
    );
    expect(sql).toContain("company ILIKE '%x\\' OR \\'1\\'=\\'1%'");
  });

  // LIKE metacharacters in a free-text param would otherwise act as wildcards: `a_b` (role) would
  // match "axb", `50%` (company) would match anything starting "50". These come from the agent's
  // free-text tool call, so they must match literally. Escape `%`/`_` (backslash-prefixed) BEFORE
  // the `%...%` substring wrapping; chStr then doubles the backslash for the string-literal layer,
  // so a literal underscore lands as `\\_` in the emitted SQL. The outer `%` stay as wildcards.
  it("escapes an underscore in a role param so it matches literally (not a LIKE wildcard)", () => {
    const { sql } = buildTemplateSql("salary_distribution", { role: "a_b" }, "postings");
    expect(sql).toContain("title ILIKE '%a\\\\_b%'");
  });

  it("escapes a percent in a company param so it matches literally (not a LIKE wildcard)", () => {
    const { sql } = buildTemplateSql("latest_postings", { company: "50%" }, "postings");
    expect(sql).toContain("company ILIKE '%50\\\\%%'");
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
