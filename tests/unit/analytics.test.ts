import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  buildComposedSql,
  buildCorpusSql,
  buildPostingDetailSql,
  buildRoleResolveSql,
  buildSearchPostingsSql,
  buildTemplateSql,
  createAnalytics,
  seniorityBand,
  SENIORITY_BANDS,
} from "@shared/analytics";
import { SENIORITY_LEVELS } from "@shared/profile";

describe("buildPostingDetailSql", () => {
  it("selects the detail columns for one posting by the natural key, FINAL + LIMIT 1", () => {
    const sql = buildPostingDetailSql("GoogleCareers", "320973146", "postings");
    expect(sql).toContain("description_text");
    expect(sql).toContain("department");
    expect(sql).toContain("apply_url");
    expect(sql).toContain("FROM postings FINAL");
    expect(sql).toContain("WHERE source = 'GoogleCareers' AND external_id = '320973146'");
    expect(sql).toContain("LIMIT 1");
  });

  it("escapes a quote in either key value (injection-safe)", () => {
    const sql = buildPostingDetailSql("src", "x' OR '1'='1", "postings");
    // The apostrophes are backslash-escaped inside the literal - never break out of the string.
    expect(sql).toContain("external_id = 'x\\' OR \\'1\\'=\\'1'");
    expect(sql).not.toContain("OR '1'='1'"); // no unescaped injection fragment survives
  });
});

describe("buildTemplateSql", () => {
  it("interpolates salary_compare cities + role and uses quantileExact over FINAL", () => {
    const { sql } = buildTemplateSql(
      "salary_compare",
      { role: "Engineer", cities: ["San Francisco", "Los Angeles"] },
      "postings",
    );
    expect(sql).toContain("FROM postings FINAL");
    expect(sql).toContain("lowerUTF8(city) IN (lowerUTF8('San Francisco'), lowerUTF8('Los Angeles'))");
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

  // A window wider than the LIMIT must keep TODAY and drop the oldest, so the trend orders
  // day DESC + LIMIT (newest slice) and flags reverse for chronological display - never `ORDER BY day`
  // ASC, which would keep the oldest 400 days and drop the most recent.
  it("orders postings_trend newest-first (+ reverse) so the LIMIT drops the oldest days, not today", () => {
    const built = buildTemplateSql("postings_trend", { days: 3650 }, "postings");
    expect(built.sql).toContain("ORDER BY day DESC");
    expect(built.sql).not.toMatch(/ORDER BY day\s*\n/);
    expect(built.reverse).toBe(true);
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
    // is escaped inside the lowerUTF8 wrap (`lowerUTF8(city) = lowerUTF8(${chStr(p.city)})`), so a
    // trailing backslash sits immediately before the quote chStr appends: the exact position where an
    // unescaped backslash would swallow it. The lowerUTF8 wrap does not change the chStr escaping.
    const { sql } = buildTemplateSql("salary_distribution", { city: "trail\\" }, "postings");
    expect(sql).toContain("lowerUTF8(city) = lowerUTF8('trail\\\\')");
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

  it("latest_postings projects apply_url (the link-out column) alongside the entity fields", () => {
    const { sql } = buildTemplateSql("latest_postings", {}, "postings");
    expect(sql).toContain("apply_url");
  });

  // Country is a chStr-equality filter on the two v1 templates the composed builder cannot
  // serve (latest_postings is an entity list; salary_distribution is the v1-only histogram shape).
  it("adds a country equality filter to latest_postings (same shape as city)", () => {
    const { sql } = buildTemplateSql("latest_postings", { country: "United States" }, "postings");
    expect(sql).toContain("lowerUTF8(country) = lowerUTF8('United States')");
  });

  it("adds a country equality filter to salary_distribution", () => {
    const { sql } = buildTemplateSql("salary_distribution", { country: "Germany" }, "postings");
    expect(sql).toContain("lowerUTF8(country) = lowerUTF8('Germany')");
  });

  it("escapes a quote in the country filter (no literal break-out)", () => {
    const { sql } = buildTemplateSql("latest_postings", { country: "Cote d'Ivoire" }, "postings");
    expect(sql).toContain("lowerUTF8(country) = lowerUTF8('Cote d\\'Ivoire')");
  });
});

// 044 AC-1: categorical FILTER matching is case-insensitive - lowerUTF8 wraps BOTH the column and the
// value, so a value's casing never changes which rows match. One home (eqCI/inCI); all THREE query
// families inherit (fixed templates, composed builder, search_postings). The matrix asserts the emitted
// SQL lowers both sides for each dimension x family x casing; the behavioural "senior == Senior == SENIOR
// hits the same rows" proof runs against real ClickHouse in analytics.integration.test.ts. stored data +
// display (SELECT / GROUP BY) casing stay untouched - only the equality/IN comparisons are wrapped.
describe("Should_MatchCaseInsensitively_When_CategoricalFilter (044 AC-1, lowerUTF8 both sides)", () => {
  const CASINGS = ["senior", "Senior", "SENIOR"] as const;

  // family+dimension -> (value) -> the emitted SQL, and the exact lowered comparison it must contain.
  const EQ_CASES: [string, (v: string) => string, (v: string) => string][] = [
    ["template salary_distribution.city", (v) => buildTemplateSql("salary_distribution", { city: v }, "postings").sql, (v) => `lowerUTF8(city) = lowerUTF8('${v}')`],
    ["template salary_distribution.country", (v) => buildTemplateSql("salary_distribution", { country: v }, "postings").sql, (v) => `lowerUTF8(country) = lowerUTF8('${v}')`],
    ["template top_companies.city", (v) => buildTemplateSql("top_companies", { city: v }, "postings").sql, (v) => `lowerUTF8(city) = lowerUTF8('${v}')`],
    ["template latest_postings.experience_level", (v) => buildTemplateSql("latest_postings", { level: v }, "postings").sql, (v) => `lowerUTF8(experience_level) = lowerUTF8('${v}')`],
    ["template latest_postings.country", (v) => buildTemplateSql("latest_postings", { country: v }, "postings").sql, (v) => `lowerUTF8(country) = lowerUTF8('${v}')`],
    ["composed city", (v) => buildComposedSql({ measures: ["count"], city: v }, "postings").sql, (v) => `lowerUTF8(city) = lowerUTF8('${v}')`],
    ["composed region", (v) => buildComposedSql({ measures: ["count"], region: v }, "postings").sql, (v) => `lowerUTF8(region) = lowerUTF8('${v}')`],
    ["composed country", (v) => buildComposedSql({ measures: ["count"], country: v }, "postings").sql, (v) => `lowerUTF8(country) = lowerUTF8('${v}')`],
    ["composed experience_level", (v) => buildComposedSql({ measures: ["count"], experience_level: v }, "postings").sql, (v) => `lowerUTF8(experience_level) = lowerUTF8('${v}')`],
    ["composed employment_type", (v) => buildComposedSql({ measures: ["count"], employment_type: v }, "postings").sql, (v) => `lowerUTF8(employment_type) = lowerUTF8('${v}')`],
  ];

  it.each(EQ_CASES)("%s lowers both sides of the equality for every casing", (_label, build, expected) => {
    for (const v of CASINGS) expect(build(v)).toContain(expected(v));
  });

  // The IN-list families: salary_compare (template), composed cities, and search_postings' city score
  // term - each lowers the column and every listed value, so a mixed-casing list still matches literally.
  it("salary_compare cities IN lowers both sides for a mixed-casing list", () => {
    const { sql } = buildTemplateSql("salary_compare", { cities: ["berlin", "MUNICH"] }, "postings");
    expect(sql).toContain("lowerUTF8(city) IN (lowerUTF8('berlin'), lowerUTF8('MUNICH'))");
  });

  it("composed cities IN lowers both sides for a mixed-casing list", () => {
    const { sql } = buildComposedSql({ measures: ["count"], cities: ["berlin", "MUNICH"] }, "postings");
    expect(sql).toContain("lowerUTF8(city) IN (lowerUTF8('berlin'), lowerUTF8('MUNICH'))");
  });

  it("search_postings city score term lowers both sides (the third family)", () => {
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["engineer"], cities: ["berlin", "MUNICH"] }, "postings");
    expect(rowsSql).toContain("(lowerUTF8(city) IN (lowerUTF8('berlin'), lowerUTF8('MUNICH')))");
  });

  it("search_postings rows projection carries apply_url through the inner and outer SELECT", () => {
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["engineer"] }, "postings");
    // Twice: once in the inner scored subquery, once re-selected in the outer projection.
    expect(rowsSql.match(/apply_url/g)?.length).toBe(2);
  });

  // The SELECT / GROUP BY projections keep the ORIGINAL casing (display + stored data untouched) - only
  // the comparison is lowered. A location_kind dimension still serializes via toString, not lowerUTF8.
  it("does not wrap the SELECT/GROUP BY dimension projection (display casing preserved)", () => {
    const { sql } = buildComposedSql({ measures: ["count"], dimensions: ["experience_level"], experience_level: "Senior" }, "postings");
    expect(sql).toContain("GROUP BY experience_level"); // grouped by the raw column, not lowerUTF8
    expect(sql).toContain("lowerUTF8(experience_level) = lowerUTF8('Senior')"); // only the FILTER is lowered
    expect(sql).not.toContain("lowerUTF8(experience_level) AS"); // the projection is never lowered
  });

  // location_kind is an Enum8 with Zod-validated canonical values - a direct equality (no lowerUTF8 wrap)
  // is intentional and correct; wrapping it would need an Enum->String cast for a semantic no-op.
  it("leaves the Zod-validated location_kind enum equality unwrapped", () => {
    const { sql } = buildComposedSql({ measures: ["count"], location_kind: "remote" }, "postings");
    expect(sql).toContain("location_kind = 'remote'");
    expect(sql).not.toContain("lowerUTF8(location_kind)");
  });
});

// "at company X for me": a company-scoped fit constrains the scored set to those companies BEFORE ranking -
// a HARD WHERE filter (case-insensitive via inCI), never an additive score term. Applied to both the rows
// query and the per-company meta query so the honest total counts only the named companies.
describe("search_postings company scope (hard filter)", () => {
  it("adds a case-insensitive inCI company filter to BOTH the rows and meta inner WHERE", () => {
    const { rowsSql, metaSql } = buildSearchPostingsSql(
      { titleTerms: ["engineer"], companies: ["ClickHouse", "Databricks"] },
      "postings",
    );
    const filter = "AND lowerUTF8(company) IN (lowerUTF8('ClickHouse'), lowerUTF8('Databricks'))";
    expect(rowsSql).toContain(filter);
    expect(metaSql).toContain(filter);
  });

  it("keeps the company constraint OUT of the additive score (it is a filter, not an addend)", () => {
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["engineer"], companies: ["ClickHouse"] }, "postings");
    // the score line multiplies title/experience/city/remote/salary only - never company
    expect(rowsSql).not.toMatch(/\*\s*\(lowerUTF8\(company\)/);
  });

  it("adds no company filter when companies is absent or empty", () => {
    expect(buildSearchPostingsSql({ titleTerms: ["engineer"] }, "postings").rowsSql).not.toContain("lowerUTF8(company)");
    expect(buildSearchPostingsSql({ titleTerms: ["engineer"], companies: [] }, "postings").rowsSql).not.toContain("lowerUTF8(company)");
  });

  it("escapes a company value as a string literal (injection-safe)", () => {
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["engineer"], companies: ["x' OR '1'='1"] }, "postings");
    expect(rowsSql).toContain("lowerUTF8('x\\' OR \\'1\\'=\\'1')");
  });

  it("rejects more than five companies (the cap)", () => {
    expect(() =>
      buildSearchPostingsSql({ titleTerms: ["engineer"], companies: ["a", "b", "c", "d", "e", "f"] }, "postings"),
    ).toThrow();
  });
});

// The roles dimension resolve: distinct role NAMES matching a phrase, read from the corpus's own
// role_names arrays (arrayJoin) via lowerUTF8 LIKE - no query-time roles API call. Names key the match,
// not the untrustworthy 64-bit wire id.
describe("buildRoleResolveSql (roles dimension, CH-resolve)", () => {
  it("fans out the corpus role_names and lowers both sides of the name LIKE, over the open set", () => {
    const sql = buildRoleResolveSql(["Backend Engineer"], "postings");
    expect(sql).toContain("arrayJoin(role_names) AS rn");
    expect(sql).toContain("SELECT DISTINCT lowerUTF8(rn) AS name"); // returns lowercased canonical names
    expect(sql).toContain("lowerUTF8(rn) LIKE '%backend engineer%'"); // phrase lowered + wrapped
    expect(sql).toContain("notEmpty(role_names)"); // unclassified rows contribute nothing
    expect(sql).toContain("ingested_at = (SELECT max(ingested_at) FROM postings)"); // open set
    expect(sql).toContain("LIMIT 100"); // bounded name list
    expect(sql).not.toContain("role_ids"); // the id is never read
  });

  it("ORs one LIKE per phrase", () => {
    const sql = buildRoleResolveSql(["backend engineer", "platform"], "postings");
    expect(sql).toContain("lowerUTF8(rn) LIKE '%backend engineer%' OR lowerUTF8(rn) LIKE '%platform%'");
  });

  it("escapes LIKE metacharacters and quote break-outs in a phrase (injection-safe, literal match)", () => {
    const sql = buildRoleResolveSql(["a_b%", "x' OR '1'='1"], "postings");
    expect(sql).toContain("LIKE '%a\\\\_b\\\\%%'"); // _ and % escaped (backslash doubled by chStr) to match literally
    expect(sql).toContain("'%x\\' or \\'1\\'=\\'1%'"); // quote break-out neutralized; phrase lowered
  });

  it("yields a no-match query (WHERE 0) when every phrase is blank", () => {
    const sql = buildRoleResolveSql(["   ", ""], "postings");
    expect(sql).toContain("WHERE 0");
  });
});

// Role-IN matching: when phrase(s) resolve to canonical role NAME(s), has(role_names, name) - case
// insensitive - is the PRIMARY weight-3 signal and the title-term hits become the fallback for
// unclassified rows. With NO resolved names the weight-3 term IS the title hits, so the SQL is
// byte-identical to the pre-roles builder (forward-compat).
describe("buildSearchPostingsSql role-IN term (name-keyed)", () => {
  it("makes role-IN the weight-3 term when names resolved: case-insensitive hasAny, title as the empty-roles fallback", () => {
    const titleOnly = buildSearchPostingsSql({ titleTerms: ["backend"] }, "postings").rowsSql;
    const withRoles = buildSearchPostingsSql({ titleTerms: ["backend"] }, "postings", ["backend engineer", "platform engineer"]).rowsSql;
    // The resolved-name branch: role-IN hit -> 2, else unclassified -> the title hits, else classified miss -> 0.
    // Both sides are lowered (arrayMap lowerUTF8 over the row's names vs the already-lowered resolved names).
    expect(withRoles).toContain(
      "3 * multiIf(hasAny(arrayMap(rn -> lowerUTF8(rn), role_names), ['backend engineer', 'platform engineer']), 2, empty(role_names), least((title ILIKE '%backend%'), 2), 0)",
    );
    // The title-only build never mentions role_names (the pre-ship shape).
    expect(titleOnly).not.toContain("role_names");
    expect(titleOnly).toContain("3 * least((title ILIKE '%backend%'), 2)");
  });

  it("is FORWARD-COMPATIBLE: an empty resolved-name list yields SQL byte-identical to the two-arg (pre-roles) call", () => {
    const params = { titleTerms: ["senior", "backend"], experience: "senior", cities: ["Berlin"], remoteOk: true, salaryMin: 150000 };
    const twoArg = buildSearchPostingsSql(params, "postings");
    const emptyRoles = buildSearchPostingsSql(params, "postings", []);
    expect(emptyRoles.rowsSql).toBe(twoArg.rowsSql);
    expect(emptyRoles.metaSql).toBe(twoArg.metaSql);
    expect(twoArg.rowsSql).not.toContain("role_names"); // no role machinery leaks into the pre-ship SQL
  });

  it("escapes a quote break-out in a resolved name (interpolated as a chStr string literal)", () => {
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["backend"] }, "postings", ["x' OR '1'='1"]);
    expect(rowsSql).toContain("hasAny(arrayMap(rn -> lowerUTF8(rn), role_names), ['x\\' OR \\'1\\'=\\'1'])");
  });

  it("accepts the model's role phrases through the strict params (the runtime resolves them to names)", () => {
    // `roles` (phrases) is a valid param the runtime resolves; the builder keys off the resolved NAMES it is handed.
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["backend"], roles: ["backend engineer"] }, "postings", ["backend engineer"]);
    expect(rowsSql).toContain("hasAny(arrayMap(rn -> lowerUTF8(rn), role_names), ['backend engineer'])");
  });
});

// Salary aggregates are filtered to the DOMINANT currency (never a mixed-currency median)
// and flagged `salary` so executeBuilt resolves the base currency for the source line + money formatter.
describe("Should_FilterToDominantCurrency_When_SalaryAggregate (018 strand 3)", () => {
  const DOMINANT = "salary_currency IN (SELECT salary_currency FROM postings FINAL";

  it("adds the dominant-currency subquery + salary flag to salary_distribution", () => {
    const built = buildTemplateSql("salary_distribution", { city: "Berlin" }, "postings");
    expect(built.sql).toContain(DOMINANT);
    expect(built.sql).toContain("ORDER BY count() DESC, salary_currency ASC");
    expect(built.salary).toBe(true);
  });

  it("adds the dominant-currency subquery + salary flag to salary_compare", () => {
    const built = buildTemplateSql(
      "salary_compare",
      { cities: ["San Francisco", "Los Angeles"] },
      "postings",
    );
    expect(built.sql).toContain(DOMINANT);
    expect(built.salary).toBe(true);
  });

  it("adds it to a composed salary measure and flags salary", () => {
    const built = buildComposedSql(
      { measures: ["median_salary"], dimensions: ["experience_level"] },
      "postings",
    );
    expect(built.sql).toContain(DOMINANT);
    expect(built.salary).toBe(true);
  });

  it("does NOT add it (nor the salary flag) to a count-only composed query", () => {
    const built = buildComposedSql({ measures: ["count"], dimensions: ["company"] }, "postings");
    expect(built.sql).not.toContain("salary_currency");
    expect(built.salary).toBeFalsy();
  });
});

describe("Should_ApplyOpenSetPredicate_When_CurrentStateRead (AC-3)", () => {
  const PREDICATE = "ingested_at = (SELECT max(ingested_at) FROM postings)";

  // The five non-trend templates read the open set (latest ingest snapshot) by default.
  it.each([
    ["salary_distribution", {}],
    ["salary_compare", { cities: ["San Francisco", "Los Angeles"] }],
    ["top_companies", {}],
    ["share_split", { dimension: "experience" }],
    ["latest_postings", {}],
  ] as const)("applies the predicate to %s (current-state template)", (name, params) => {
    expect(buildTemplateSql(name, params, "postings").sql).toContain(PREDICATE);
  });

  it("applies the predicate to a bare composed query (no days window)", () => {
    expect(buildComposedSql({ measures: ["count"], dimensions: ["company"] }, "postings").sql).toContain(
      PREDICATE,
    );
  });

  // A trend / any days-windowed read keeps full history - closed postings are legitimate history.
  it("does NOT apply the predicate to postings_trend", () => {
    expect(buildTemplateSql("postings_trend", { days: 7 }, "postings").sql).not.toContain("ingested_at =");
  });

  it("does NOT apply the predicate to days-windowed top_companies", () => {
    expect(buildTemplateSql("top_companies", { days: 30 }, "postings").sql).not.toContain("ingested_at =");
  });

  it("does NOT apply the predicate to a days-windowed composed query", () => {
    expect(
      buildComposedSql({ measures: ["count"], dimensions: ["company"], days: 30 }, "postings").sql,
    ).not.toContain("ingested_at =");
  });

  // The predicate must live in the shared WHERE so the sampleN/freshestAt meta query counts the same set.
  it("carries the predicate in the returned `where` (so the meta query counts the open set)", () => {
    expect(buildTemplateSql("top_companies", {}, "postings").where).toContain(PREDICATE);
    expect(buildComposedSql({ measures: ["count"] }, "postings").where).toContain(PREDICATE);
  });

  // The BuiltQuery.openSet flag is what runQuery/runComposedQuery thread into meta.openSet.
  it("flags openSet true for current-state reads and false for windowed reads", () => {
    expect(buildTemplateSql("top_companies", {}, "postings").openSet).toBe(true);
    expect(buildTemplateSql("top_companies", { days: 30 }, "postings").openSet).toBe(false);
    expect(buildTemplateSql("postings_trend", { days: 7 }, "postings").openSet).toBe(false);
    expect(buildComposedSql({ measures: ["count"] }, "postings").openSet).toBe(true);
    expect(buildComposedSql({ measures: ["count"], days: 7 }, "postings").openSet).toBe(false);
  });
});

describe("Should_RejectUnknownParams_When_ComposedQueryBuilt (AC-2)", () => {
  it.each([
    ["unknown measure", { measures: ["avg_salary"] }],
    ["unknown dimension", { measures: ["count"], dimensions: ["salary"] }],
    ["unknown filter key", { measures: ["count"], bogus: 1 }],
    ["unknown time bucket", { measures: ["count"], bucket: "hour" }],
    ["zero measures", { measures: [] }],
    ["three measures", { measures: ["count", "median_salary", "p25_salary"] }],
    ["three dimensions", { measures: ["count"], dimensions: ["company", "city", "region"] }],
    ["limit above 50", { measures: ["count"], limit: 51 }],
    ["duplicate dimension", { measures: ["count"], dimensions: ["company", "company"] }],
    ["invalid location_kind", { measures: ["count"], location_kind: "office" }],
    // The inner `sort` object must be `.strict()` too - an unknown key inside it (with `by`/`dir`
    // still valid) must be REJECTED, not silently stripped, to hold the reject-unknown contract
    // uniformly. `dimensions: ["company"]` makes `sort.by` a valid selection, so the ONLY reason to
    // throw is the unknown `evil` key.
    [
      "unknown key inside sort",
      { measures: ["count"], dimensions: ["company"], sort: { by: "company", dir: "asc", evil: 1 } },
    ],
    // Salary bounds are capped like `days`/`limit` in the same schema (bounded-number discipline;
    // also keeps any interpolated integer well below the >= 1e21 scientific-notation edge).
    ["min_salary above the currency cap", { measures: ["count"], min_salary: 1_000_000_001 }],
    ["max_salary above the currency cap", { measures: ["count"], max_salary: 1_000_000_001 }],
  ])("rejects %s before any query is built", (_label, params) => {
    expect(() => buildComposedSql(params, "postings")).toThrow();
  });

  it("rejects a sort key that is not a selected measure or dimension", () => {
    expect(() =>
      buildComposedSql(
        { measures: ["count"], dimensions: ["company"], sort: { by: "city", dir: "asc" } },
        "postings",
      ),
    ).toThrow();
  });

  // Injection-style free-text is ACCEPTED (a valid string) but escaped in the emitted SQL - the same
  // chStr/likeEscape contract the templates hold. It must stay inert, not be rejected.
  it("escapes injection strings in a free-text filter rather than rejecting them", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], dimensions: ["company"], company: "x' OR '1'='1" },
      "postings",
    );
    expect(sql).toContain("company ILIKE '%x\\' OR \\'1\\'=\\'1%'");
  });

  it("escapes a bare city equality break-out attempt", () => {
    const { sql } = buildComposedSql({ measures: ["count"], city: "trail\\" }, "postings");
    expect(sql).toContain("lowerUTF8(city) = lowerUTF8('trail\\\\')");
  });

  // `city` and `cities` coexisting used to AND (`city = X AND city IN (...)`),
  // a possibly-empty intersection. The FOLLOW-UP INHERITANCE rule REPLACES a filter rather than adding, so
  // when both are present `cities` (the multi-city list) WINS and the single `city` is dropped - never an
  // empty-intersection surprise. Documented in the schema; pinned here.
  it("prefers cities over a coexisting single city (no AND-ed empty intersection)", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], city: "Berlin", cities: ["Los Angeles", "New York"] },
      "postings",
    );
    expect(sql).toContain("lowerUTF8(city) IN (lowerUTF8('Los Angeles'), lowerUTF8('New York'))");
    expect(sql).not.toContain("lowerUTF8(city) = lowerUTF8('Berlin')"); // the single city loses to the list
  });

  it("still applies a single city when no cities list is present", () => {
    const { sql } = buildComposedSql({ measures: ["count"], city: "Berlin" }, "postings");
    expect(sql).toContain("lowerUTF8(city) = lowerUTF8('Berlin')");
  });
});

describe("Should_BuildExpectedSql_When_ValidCombos (AC-2)", () => {
  // Canonical shape locked exactly: count by company, open-set, deterministic order (mirrors top_companies).
  it("count by company -> grouped, open-set, measure-desc then dimension-asc", () => {
    const { sql } = buildComposedSql({ measures: ["count"], dimensions: ["company"] }, "postings");
    expect(sql).toBe(
      [
        "SELECT",
        "  company,",
        "  count() AS count",
        "FROM postings FINAL",
        "WHERE ingested_at = (SELECT max(ingested_at) FROM postings)",
        "GROUP BY company",
        "ORDER BY count DESC, company ASC",
        "LIMIT 20",
      ].join("\n"),
    );
  });

  // A single overall aggregate (no dimensions, no bucket) - no GROUP BY, still deterministic.
  it("a single measure with no dimensions omits GROUP BY", () => {
    const { sql } = buildComposedSql({ measures: ["count"] }, "postings");
    expect(sql).not.toContain("GROUP BY");
    expect(sql).toContain("count() AS count");
    expect(sql).toContain("ORDER BY count DESC");
  });

  // "median salary by experience level": salary measure implies the NOT NULL filter.
  it("median_salary by experience_level implies the NOT NULL salary filter", () => {
    const { sql } = buildComposedSql(
      { measures: ["median_salary"], dimensions: ["experience_level"] },
      "postings",
    );
    expect(sql).toContain("salary_min IS NOT NULL");
    expect(sql).toContain("salary_max IS NOT NULL");
    expect(sql).toContain("round(quantileExact(0.5)((salary_min + salary_max) / 2)) AS median_salary");
    expect(sql).toContain("GROUP BY experience_level");
    expect(sql).toContain("ORDER BY median_salary DESC, experience_level ASC");
  });

  it("p25/p75 salary measures map to their quantiles", () => {
    const { sql } = buildComposedSql({ measures: ["p25_salary", "p75_salary"] }, "postings");
    expect(sql).toContain("round(quantileExact(0.25)((salary_min + salary_max) / 2)) AS p25_salary");
    expect(sql).toContain("round(quantileExact(0.75)((salary_min + salary_max) / 2)) AS p75_salary");
  });

  // "top companies in the US": a country filter alongside a company dimension.
  it("count by company filtered to a country", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], dimensions: ["company"], country: "United States" },
      "postings",
    );
    expect(sql).toContain("lowerUTF8(country) = lowerUTF8('United States')");
    expect(sql).toContain("GROUP BY company");
  });

  // A time bucket is a GROUP BY expression aliased `bucket` for stable Recharts keys. A pure trend is
  // ordered NEWEST-first (bucket DESC) + LIMIT so a series longer than the cap keeps recent buckets and
  // drops the oldest; the reverse flag flips the rows back to chronological for display.
  it("a pure time-bucket trend orders bucket DESC (+ reverse) so the newest buckets survive the LIMIT", () => {
    const built = buildComposedSql({ measures: ["count"], bucket: "week" }, "postings");
    expect(built.sql).toContain("toStartOfWeek(published_at) AS bucket");
    expect(built.sql).toContain("GROUP BY toStartOfWeek(published_at)");
    expect(built.sql).toContain("ORDER BY toStartOfWeek(published_at) DESC");
    expect(built.reverse).toBe(true);
  });

  // Two dimensions together: GROUP BY carries both, in the array order; the deterministic ORDER BY is
  // the sort spec (default: the measure DESC) then the REMAINING dimensions ASC in the same order - the
  // exact composition every valid-combo test above exercised with only ONE dimension, never two.
  it("two dimensions group by both and order by the measure then both dimensions ASC", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], dimensions: ["company", "city"] },
      "postings",
    );
    expect(sql).toBe(
      [
        "SELECT",
        "  company,",
        "  city,",
        "  count() AS count",
        "FROM postings FINAL",
        "WHERE ingested_at = (SELECT max(ingested_at) FROM postings)",
        "GROUP BY company, city",
        "ORDER BY count DESC, company ASC, city ASC",
        "LIMIT 20",
      ].join("\n"),
    );
  });

  // A dimension AND a time bucket together.
  // Default sort is chronological (bucket ASC) even with a dimension present; the dimension becomes the
  // remaining ASC tiebreaker. Distinct from the single-dimension and bucket-only cases above.
  it("a dimension plus a time bucket groups by both, sorted chronologically by default", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], dimensions: ["company"], bucket: "week" },
      "postings",
    );
    expect(sql).toBe(
      [
        "SELECT",
        "  company,",
        "  toStartOfWeek(published_at) AS bucket,",
        "  count() AS count",
        "FROM postings FINAL",
        "WHERE ingested_at = (SELECT max(ingested_at) FROM postings)",
        "GROUP BY company, toStartOfWeek(published_at)",
        "ORDER BY toStartOfWeek(published_at) ASC, company ASC",
        "LIMIT 20",
      ].join("\n"),
    );
  });

  // An explicit sort override on the dimension (not the bucket) puts the dimension first in ORDER BY -
  // proves `sort.by` can select either the dimension or the bucket key when both are present.
  it("an explicit sort by the dimension overrides the bucket-first default", () => {
    const { sql } = buildComposedSql(
      {
        measures: ["count"],
        dimensions: ["company"],
        bucket: "week",
        sort: { by: "company", dir: "desc" },
      },
      "postings",
    );
    expect(sql).toContain("ORDER BY company DESC, toStartOfWeek(published_at) ASC");
  });

  // location_kind (Enum8) is toString'd so it serializes/orders by name, and grouped by the raw
  // expression so the `location_kind` alias never shadows the column.
  // A bucketed CROSS-TAB (a dimension alongside the bucket) is a table, not a trend, so it
  // keeps chronological ASC order and is NOT reversed - only a pure trend flips to newest-first.
  it("a dimension + bucket keeps ASC order and does not set reverse (only a pure trend does)", () => {
    const built = buildComposedSql({ measures: ["count"], dimensions: ["company"], bucket: "week" }, "postings");
    expect(built.sql).toContain("ORDER BY toStartOfWeek(published_at) ASC, company ASC");
    expect(built.reverse).toBeFalsy();
  });

  it("a location_kind dimension is toString'd and grouped by the raw expression", () => {
    const { sql } = buildComposedSql({ measures: ["count"], dimensions: ["location_kind"] }, "postings");
    expect(sql).toContain("toString(location_kind) AS location_kind");
    expect(sql).toContain("GROUP BY toString(location_kind)");
  });

  // A multi-city filter ("openings in LA or NYC") is a chStr-escaped IN-list on city.
  it("builds a cities IN-list filter, each value escaped", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], cities: ["Los Angeles", "New York"] },
      "postings",
    );
    expect(sql).toContain("lowerUTF8(city) IN (lowerUTF8('Los Angeles'), lowerUTF8('New York'))");
  });

  it("escapes a quote break-out inside the cities IN-list", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], cities: ["x' OR '1'='1"] },
      "postings",
    );
    expect(sql).toContain("lowerUTF8(city) IN (lowerUTF8('x\\' OR \\'1\\'=\\'1'))");
  });

  // Escaping must be applied PER-ELEMENT across a multi-city list - a bug that escaped only cities[0]
  // (or joined the raw array before wrapping) would slip through. Probe an injection payload in a
  // NON-first position alongside a clean city.
  it("escapes a quote break-out in a non-first element of a multi-city IN-list", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], cities: ["Los Angeles", "x' OR '1'='1", "New York"] },
      "postings",
    );
    expect(sql).toContain(
      "lowerUTF8(city) IN (lowerUTF8('Los Angeles'), lowerUTF8('x\\' OR \\'1\\'=\\'1'), lowerUTF8('New York'))",
    );
  });

  it("a location_kind equality filter is accepted for the three enum values", () => {
    const { sql } = buildComposedSql({ measures: ["count"], location_kind: "remote" }, "postings");
    expect(sql).toContain("location_kind = 'remote'");
  });

  it("salary bound filters compare the midpoint", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], min_salary: 100000, max_salary: 200000 },
      "postings",
    );
    expect(sql).toContain("(salary_min + salary_max) / 2 >= 100000");
    expect(sql).toContain("(salary_min + salary_max) / 2 <= 200000");
  });

  it("honors an explicit sort override and the limit bound", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], dimensions: ["company"], sort: { by: "company", dir: "asc" }, limit: 5 },
      "postings",
    );
    expect(sql).toContain("ORDER BY company ASC");
    expect(sql).toContain("LIMIT 5");
  });

  it("honors the injected table name", () => {
    expect(buildComposedSql({ measures: ["count"] }, "postings_test").sql).toContain(
      "FROM postings_test FINAL",
    );
  });
});

// The profile-driven selection scorer (030). searchPostings builds a whitelisted, deterministic
// scored query - the FIXED formula 3*min(titleTermHits,2) + 2*experienceMatch + 2*cityMatch +
// 1*(remoteOk AND remote) + 1*salaryFloorMet, ORDER BY score DESC, publishedAt DESC. The seniority
// mapping is case-insensitive over the live experience_level values (recorded 2026-07-22).
describe("seniorityBand (case-insensitive mapping from the live experience_level values)", () => {
  // The observed live DISTINCT values (open set, 2026-07-22): "Senior","Staff","Mid","senior","",
  // "executive","mid-level","internship","principal". Each maps to one of the 4 profile bands (or "").
  it.each([
    ["Senior", "senior"],
    ["senior", "senior"], // case variant seen live
    ["Staff", "lead"],
    ["Mid", "mid"],
    ["mid-level", "mid"],
    ["executive", "lead"],
    ["principal", "lead"],
    ["internship", "junior"],
    ["", ""], // empty -> no band (no experience points)
    ["Unheard-of Level", ""], // an unmapped value contributes no experience points
  ])("maps %j -> %j", (input, band) => {
    expect(seniorityBand(input)).toBe(band);
  });
});

// One-home contract: BAND_KEYWORDS (private to shared/analytics.ts) is the SOLE source both
// `seniorityBand` (TS, the requested-band normalization) and the SQL `multiIf` (seniorityBandSql, over
// the posting's experience_level) derive from. A joint assertion per band - the TS mapping AND the SQL
// clause for the SAME keyword - so a future refactor that forks them into two separate lists (defeating
// the one-home design) fails here, even though today's single shared array cannot itself diverge.
describe("BAND_KEYWORDS one home (TS seniorityBand + SQL multiIf move together)", () => {
  it.each([
    ["junior", "graduate"],
    ["senior", "senior"],
    ["lead", "director"],
    ["mid", "intermediate"],
  ])("the %s-band keyword %j classifies identically in TS and in the SQL multiIf", (band, keyword) => {
    expect(seniorityBand(keyword)).toBe(band);
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["x"], experience: keyword }, "postings");
    // The SQL requested-band comparison target (2 * (multiIf(...) = '<band>')) must match seniorityBand's
    // own answer for this keyword, and the multiIf must carry an ILIKE clause built from it.
    expect(rowsSql).toContain(`= '${band}')`);
    expect(rowsSql).toContain(`experience_level ILIKE '%${keyword}%'`);
  });
});

// AC-13 forces a SECOND home for the seniority values: shared/analytics.ts may NOT import
// @shared/profile, so SENIORITY_BANDS (the scorer's bands) duplicates the profile's SENIORITY_LEVELS with
// no compile-time link. A test MAY import both (the grep gate is on the source, not tests), so this guards
// the latent coupling: a new profile seniority level must be added to the scorer's bands in lockstep, or
// this fails - the one place the two lists are checked to agree.
describe("SENIORITY_BANDS agrees with the profile SENIORITY_LEVELS (forced-duplication guard, AC-13)", () => {
  it("the scorer's bands are exactly the profile's seniority enum (same values, same count)", () => {
    expect(new Set(SENIORITY_BANDS)).toEqual(new Set(SENIORITY_LEVELS));
    expect(SENIORITY_BANDS.length).toBe(SENIORITY_LEVELS.length);
  });
});

describe("Should_ScoreByFixedFormula_When_SearchPostingsBuilt (AC-7/AC-8)", () => {
  const params = {
    titleTerms: ["senior", "backend", "engineer"],
    experience: "senior",
    cities: ["Berlin", "Munich"],
    remoteOk: true,
    salaryMin: 150000,
  };

  it("emits the exact fixed score formula (weights 3/2/2/1/1) with the title-hit cap at 2", () => {
    const { rowsSql } = buildSearchPostingsSql(params, "postings");
    // 3 * least(<sum of title ILIKEs>, 2)
    expect(rowsSql).toContain(
      "3 * least((title ILIKE '%senior%') + (title ILIKE '%backend%') + (title ILIKE '%engineer%'), 2)",
    );
    // 2 * experienceMatch (the posting's mapped band = the requested band)
    expect(rowsSql).toContain("2 * (multiIf(");
    expect(rowsSql).toContain("= 'senior')");
    // 2 * cityMatch (case-insensitive: lowerUTF8 both sides - 044 AC-1, the search_postings family)
    expect(rowsSql).toContain("2 * (lowerUTF8(city) IN (lowerUTF8('Berlin'), lowerUTF8('Munich')))");
    // 1 * (remoteOk AND remote)
    expect(rowsSql).toContain("1 * (location_kind = 'remote')");
    // 1 * salaryFloorMet (the posting ceiling reaches the requested floor; NULL salary is never a match)
    expect(rowsSql).toContain("1 * (salary_max IS NOT NULL AND salary_max >= 150000)");
  });

  it("orders by score DESC, salary-listed DESC, then publishedAt DESC, over the open set, keeping only real-signal matches (B1)", () => {
    const { rowsSql } = buildSearchPostingsSql(params, "postings");
    expect(rowsSql).toContain("FROM postings FINAL");
    expect(rowsSql).toContain("WHERE ingested_at = (SELECT max(ingested_at) FROM postings)");
    expect(rowsSql).toContain("WHERE matched"); // B1 honest gate (role/title/city), not seniority-alone score > 0
    // Item 4 (register 20) tie-break: within equal scores, salary-listed rows and freshest first
    // (deterministic - a listed-salary US row never sinks below an unlisted India row on a score tie).
    expect(rowsSql).toContain(
      "ORDER BY score DESC, (salary_min IS NOT NULL OR salary_max IS NOT NULL) DESC, published_at DESC",
    );
    expect(rowsSql).toContain("LIMIT 10"); // interface default
  });

  it("maps the experience_level band case-insensitively via ILIKE (the live case variants)", () => {
    const { rowsSql } = buildSearchPostingsSql(params, "postings");
    expect(rowsSql).toContain("experience_level ILIKE '%senior%'");
    expect(rowsSql).toContain("experience_level ILIKE '%staff%'"); // lead band keyword
    expect(rowsSql).toContain("experience_level ILIKE '%intern%'"); // junior band keyword
  });

  it("drops a formula term to 0 when its param is absent (formula stays verbatim)", () => {
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["engineer"] }, "postings");
    expect(rowsSql).toContain("3 * least((title ILIKE '%engineer%'), 2)");
    expect(rowsSql).toContain("2 * 0 + 2 * 0 + 1 * 0 + 1 * 0"); // experience/city/remote/salary all absent
  });

  it("does NOT add the experience term for an unmapped requested experience", () => {
    const { rowsSql } = buildSearchPostingsSql(
      { titleTerms: ["engineer"], experience: "wizard" },
      "postings",
    );
    expect(rowsSql).toContain("3 * least((title ILIKE '%engineer%'), 2) + 2 * 0"); // no band -> 0
  });

  it("escapes injection-style free-text in titleTerms and cities (the chStr/likeEscape contract)", () => {
    const { rowsSql } = buildSearchPostingsSql(
      { titleTerms: ["x' OR '1'='1"], cities: ["y' OR '1'='1"] },
      "postings",
    );
    expect(rowsSql).toContain("title ILIKE '%x\\' OR \\'1\\'=\\'1%'");
    expect(rowsSql).toContain("lowerUTF8(city) IN (lowerUTF8('y\\' OR \\'1\\'=\\'1'))");
  });

  it("computes the meta over the matched set (total, freshestAt, dominant company)", () => {
    const { metaSql } = buildSearchPostingsSql(params, "postings");
    expect(metaSql).toContain("count() AS c");
    expect(metaSql).toContain("max(ingested_at) AS freshestAt");
    expect(metaSql).toContain("WHERE matched"); // B1: the honest count gates on a real signal, not score > 0
    expect(metaSql).toContain("GROUP BY company");
    expect(metaSql).toContain("ORDER BY c DESC, company ASC");
  });

  it("honors the injected table name and a raised limit (the emitter's hard cap of 50)", () => {
    const { rowsSql, metaSql } = buildSearchPostingsSql(
      { titleTerms: ["engineer"], limit: 50 },
      "postings_test",
    );
    expect(rowsSql).toContain("FROM postings_test FINAL");
    expect(rowsSql).toContain("LIMIT 50");
    expect(metaSql).toContain("FROM postings_test FINAL");
  });

  it("rejects invalid params at the boundary (Zod, strict)", () => {
    expect(() => buildSearchPostingsSql({ titleTerms: ["a"], bogus: 1 }, "postings")).toThrow(); // strict
    expect(() => buildSearchPostingsSql({ limit: 51 }, "postings")).toThrow(); // hard cap 50
    expect(() => buildSearchPostingsSql({ salaryMin: -1 }, "postings")).toThrow(); // positive
  });
});

// B1 HONEST COUNT (056): the fit gate must require a REAL role/title/city signal. Seniority band alone
// scored 2 and passed the old `score > 0` gate (every senior posting counted - the 5799 inflation). The
// new gate is `matched` = (roleOrTitleTerm > 0) OR cityTerm; seniority/salary/remote still rank but never
// alone make a match. A legacy (canonicalRoles empty) title-only match MUST still count.
describe("B1 honest-count gate: a real role/title/city signal, not seniority-alone (056)", () => {
  it("gates rows + meta on `matched`, and the gate never references the seniority band", () => {
    const { rowsSql, metaSql } = buildSearchPostingsSql(
      { titleTerms: ["engineer"], experience: "senior" }, // senior band present, NO city
      "postings",
    );
    expect(rowsSql).toContain("WHERE matched");
    expect(metaSql).toContain("WHERE matched");
    expect(rowsSql).not.toContain("WHERE score > 0");
    expect(metaSql).not.toContain("WHERE score > 0");
    // matched = (roleOrTitleTerm > 0) OR cityTerm; with no city it is `OR 0`, and it never carries the
    // band comparison (= 'senior') - so a seniority-band-alone posting no longer counts.
    expect(rowsSql).toContain("((least((title ILIKE '%engineer%'), 2)) > 0 OR 0) AS matched");
  });

  it("a legacy (canonicalRoles empty) title-only match STILL counts - the title term drives the gate", () => {
    const { rowsSql } = buildSearchPostingsSql({ titleTerms: ["qa", "test"] }, "postings");
    expect(rowsSql).toContain(
      "((least((title ILIKE '%qa%') + (title ILIKE '%test%'), 2)) > 0 OR 0) AS matched",
    );
    expect(rowsSql).toContain("WHERE matched");
  });

  it("a city match alone (no title/role) still counts - a location signal is real", () => {
    const { rowsSql } = buildSearchPostingsSql({ cities: ["Berlin"] }, "postings");
    expect(rowsSql).toContain("((0) > 0 OR (lowerUTF8(city) IN (lowerUTF8('Berlin')))) AS matched");
  });

  it("folds a resolved canonical role into the gate (roleMatch OR title fallback), still excluding seniority-alone", () => {
    const { rowsSql } = buildSearchPostingsSql(
      { titleTerms: ["engineer"], experience: "senior" },
      "postings",
      ["sdet", "test engineer"], // already-lowercased canonical role names
    );
    expect(rowsSql).toContain(
      "((multiIf(hasAny(arrayMap(rn -> lowerUTF8(rn), role_names), ['sdet', 'test engineer']), 2, empty(role_names), least((title ILIKE '%engineer%'), 2), 0)) > 0 OR 0) AS matched",
    );
  });
});

// Item 4 (056): searchPostings keys the role-IN signal off the PROFILE's canonicalRoles (server-side,
// authoritative), NOT the model's role phrases, when the profile carries them. They are already canonical
// (resolved from searchnapply autocomplete at extraction), so they are used DIRECTLY (lowercased) and the
// query-time role-resolve CH read is skipped. A legacy profile (canonicalRoles empty) falls back to
// resolving the model's role phrases against the corpus, exactly as before.
describe("searchPostings uses the profile's canonicalRoles authoritatively (056 item 4)", () => {
  function recordingClient() {
    const queries: string[] = [];
    const client = {
      query: async ({ query }: { query: string }) => {
        queries.push(query);
        return { json: async () => [] as unknown[] };
      },
    } as unknown as ClickHouseClient;
    return { client, queries };
  }

  it("uses canonicalRoles directly (lowercased) for has(role_names, ...) and SKIPS the role-resolve read", async () => {
    const { client, queries } = recordingClient();
    const analytics = createAnalytics({ client, table: "postings" });
    await analytics.searchPostings({
      titleTerms: ["engineer"],
      roles: ["ignored model phrase"], // ignored when canonicalRoles is present
      canonicalRoles: ["SDET", "Test Engineer"],
      limit: 50,
    });
    expect(queries.some((q) => q.includes("arrayJoin(role_names)"))).toBe(false); // no role-resolve read
    const rowsQuery = queries.find((q) => q.includes("AS matched"))!;
    expect(rowsQuery).toContain(
      "hasAny(arrayMap(rn -> lowerUTF8(rn), role_names), ['sdet', 'test engineer'])",
    );
    expect(rowsQuery).not.toContain("ignored model phrase"); // the model phrase never keys the role signal
  });

  it("falls back to resolving the model's role phrases when canonicalRoles is empty (legacy profile)", async () => {
    const { client, queries } = recordingClient();
    const analytics = createAnalytics({ client, table: "postings" });
    await analytics.searchPostings({
      titleTerms: ["engineer"],
      roles: ["backend engineer"],
      canonicalRoles: [],
      limit: 50,
    });
    expect(queries.some((q) => q.includes("arrayJoin(role_names)"))).toBe(true); // the resolve read fires
  });
});

// executeBuilt runs the rows query and the sampleN/freshestAt meta query. They are independent reads,
// so on the per-turn hot path they must fire CONCURRENTLY (max- not sum-latency), and a failure in
// either must surface without leaking the sibling's rejection as an unhandled rejection.
describe("executeBuilt fires the rows and meta queries concurrently (perf)", () => {
  const isMetaQuery = (sql: string): boolean => sql.includes("sampleN");

  it("issues BOTH queries before the rows query resolves (not sequentially)", async () => {
    const queries: string[] = [];
    let releaseRows!: () => void;
    const rowsGate = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });
    const client = {
      query: (opts: { query: string }) => {
        queries.push(opts.query);
        const meta = isMetaQuery(opts.query);
        return Promise.resolve({
          json: async () => {
            if (!meta) await rowsGate; // the rows query stays pending until we release it
            return meta ? [{ sampleN: 1, freshestAt: "2026-07-20 00:00:00" }] : [];
          },
        });
      },
    } as unknown as ClickHouseClient;

    const analytics = createAnalytics({ client, table: "postings_test" });
    const done = analytics.runComposedQuery({ measures: ["count"] });
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain microtasks

    // The sequential path would issue ONLY the rows query here (meta waits for rows to resolve); the
    // concurrent path issues both up front.
    expect(queries.length).toBe(2);

    releaseRows();
    await done;
  });

  // A reverse-flagged (newest-first) trend slice is flipped back to chronological order
  // for the display axis. The rows query returns day DESC; the result must come back day ASC.
  it("reverses a newest-first trend slice so the display axis runs oldest -> newest", async () => {
    const descRows = [
      { day: "2026-07-20", count: 9 },
      { day: "2026-07-19", count: 5 },
      { day: "2026-07-18", count: 2 },
    ];
    const client = {
      query: (opts: { query: string }) =>
        Promise.resolve({
          json: async () =>
            opts.query.includes("sampleN")
              ? [{ sampleN: 16, freshestAt: "2026-07-20 00:00:00" }]
              : descRows,
        }),
    } as unknown as ClickHouseClient;

    const analytics = createAnalytics({ client, table: "postings_test" });
    const res = await analytics.runComposedQuery({ measures: ["count"], bucket: "day" });
    expect(res.rows.map((r) => r.day)).toEqual(["2026-07-18", "2026-07-19", "2026-07-20"]);
  });

  // A salary aggregate's meta query resolves the dominant currency, which threads into
  // result.meta.currency (the source line + money formatter read it). A count query carries no currency.
  it("threads the resolved currency into meta for a salary aggregate", async () => {
    const client = {
      query: (opts: { query: string }) =>
        Promise.resolve({
          json: async () =>
            opts.query.includes("sampleN")
              ? [{ sampleN: 300, freshestAt: "2026-07-20 00:00:00", currency: "EUR" }]
              : [{ experience_level: "Senior", median_salary: 90000 }],
        }),
    } as unknown as ClickHouseClient;
    const analytics = createAnalytics({ client, table: "postings_test" });
    const res = await analytics.runComposedQuery({
      measures: ["median_salary"],
      dimensions: ["experience_level"],
    });
    expect(res.meta.currency).toBe("EUR");
  });

  it("carries no currency for a non-salary (count) query", async () => {
    const client = {
      query: (opts: { query: string }) =>
        Promise.resolve({
          json: async () =>
            opts.query.includes("sampleN")
              ? [{ sampleN: 10, freshestAt: "2026-07-20 00:00:00" }]
              : [{ company: "Google", count: 4 }],
        }),
    } as unknown as ClickHouseClient;
    const analytics = createAnalytics({ client, table: "postings_test" });
    const res = await analytics.runComposedQuery({ measures: ["count"], dimensions: ["company"] });
    expect(res.meta.currency).toBeUndefined();
  });

  // coverageProfile returns the corpus shape from ONE query and memoizes on the instance.
  it("computes the corpus shape and memoizes (one query per instance)", async () => {
    let calls = 0;
    const client = {
      query: () => {
        calls++;
        return Promise.resolve({
          json: async () => [
            {
              total: 3488,
              distinctCompanies: 7,
              freshestAt: "2026-07-20 06:00:00",
              salaryCoverage: 0.65,
              topCompany: "Google",
              topCompanyCount: 3257,
            },
          ],
        });
      },
    } as unknown as ClickHouseClient;

    const analytics = createAnalytics({ client, table: "postings" });
    const p1 = await analytics.coverageProfile();
    const p2 = await analytics.coverageProfile();

    expect(p1.total).toBe(3488);
    expect(p1.distinctCompanies).toBe(7);
    expect(p1.topCompany).toBe("Google");
    expect(p1.topCompanyShare).toBeCloseTo(3257 / 3488, 4);
    expect(p1.salaryCoverage).toBe(0.65);
    expect(calls).toBe(1); // memoized: the second call reuses the cached promise
    expect(p2).toBe(p1);
  });

  // A REJECTED coverage query must NOT be cached forever. The `??=` memo
  // stored the promise eagerly, so one transient ClickHouse error poisoned the cache for the whole isolate
  // life and silently dropped the DATA SCOPE note on every later turn. The cache must clear on rejection so
  // the next call retries. Driven through the REAL memo (not an injected profile): first query throws,
  // second succeeds.
  it("does NOT cache a rejected coverage query - the next call retries and succeeds", async () => {
    let calls = 0;
    const client = {
      query: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("clickhouse hiccup"));
        return Promise.resolve({
          json: async () => [
            {
              total: 3488,
              distinctCompanies: 7,
              freshestAt: "2026-07-20 06:00:00",
              salaryCoverage: 0.65,
              topCompany: "Google",
              topCompanyCount: 3257,
            },
          ],
        });
      },
    } as unknown as ClickHouseClient;

    const analytics = createAnalytics({ client, table: "postings" });
    // First call rejects (transient error) - and must not poison the cache.
    await expect(analytics.coverageProfile()).rejects.toThrow("clickhouse hiccup");
    // Second call retries the query and resolves with the real shape.
    const p = await analytics.coverageProfile();
    expect(p.total).toBe(3488);
    expect(p.topCompany).toBe("Google");
    expect(calls).toBe(2); // the rejected promise was cleared, so a real retry happened
    // A THIRD call is served from the now-fulfilled cache (no extra query).
    const p3 = await analytics.coverageProfile();
    expect(p3).toBe(p);
    expect(calls).toBe(2);
  });

  it("rejects with the failing query's error and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = {
        query: (opts: { query: string }) => {
          const meta = isMetaQuery(opts.query);
          return Promise.resolve({
            // rows rejects immediately; meta rejects slightly later - a fire-then-await-sequentially
            // implementation would leak the meta rejection as unhandled once rows throws.
            json: () =>
              meta
                ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error("meta boom")), 5))
                : Promise.reject(new Error("rows boom")),
          });
        },
      } as unknown as ClickHouseClient;

      const analytics = createAnalytics({ client, table: "postings_test" });
      await expect(analytics.runComposedQuery({ measures: ["count"] })).rejects.toThrow("rows boom");

      await new Promise((resolve) => setTimeout(resolve, 25)); // let the meta rejection settle
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// 044 AC-2: the per-conversation CORPUS summary query - ONE read over the open set describing what the
// live data contains. Pure builder (shape pinned here); the note it feeds is rendered/tested in run-scope.
describe("buildCorpusSql (044 AC-2 corpus summary query)", () => {
  const sql = buildCorpusSql("postings_test");

  it("reads the open set once with the headline aggregates", () => {
    expect(sql).toContain("count() AS total");
    expect(sql).toContain("toString(max(ingested_at)) AS freshestAt");
    expect(sql).toContain("countIf(salary_min IS NOT NULL AND salary_max IS NOT NULL) / count()");
    // The top-level read AND every subquery scope to the open set (latest ingest snapshot).
    expect(sql).toContain("ingested_at = (SELECT max(ingested_at) FROM postings_test)");
    expect(sql).toContain("FROM postings_test FINAL");
  });

  it("selects top cities and countries by frequency, non-null only", () => {
    expect(sql).toContain("groupArray(city)");
    expect(sql).toContain("city IS NOT NULL AND city != ''");
    expect(sql).toContain("ORDER BY count() DESC, city ASC LIMIT 15");
    expect(sql).toContain("groupArray(country)");
    expect(sql).toContain("country IS NOT NULL AND country != ''");
    expect(sql).toContain("LIMIT 40");
  });

  it("dedupes each free-text categorical by lowercased group, keeping the most frequent casing", () => {
    // canonical spelling = argMax(value, per-casing count) within each lowerUTF8 group.
    expect(sql).toContain("argMax(experience_level, c)");
    expect(sql).toContain("GROUP BY lowerUTF8(experience_level)");
    expect(sql).toContain("argMax(employment_type, c)");
    expect(sql).toContain("GROUP BY lowerUTF8(employment_type)");
  });

  it("serializes location_kind by name and returns source names + shares as aligned parallel arrays", () => {
    expect(sql).toContain("toString(location_kind) AS v");
    expect(sql).toContain("AS locationKinds");
    expect(sql).toContain("groupArray(source)");
    expect(sql).toContain("AS sourceNames");
    expect(sql).toContain("AS sourceShares");
    expect(sql).toContain("round(count() / (SELECT count()"); // share denominator = open-set total
  });
});

describe("analytics.corpusSummary parses the corpus row (044 AC-2)", () => {
  it("maps the single JSON row into a CorpusSummary, pairing source names with shares by index", async () => {
    const row = {
      total: 3488,
      freshestAt: "2026-07-18 06:00:00",
      salaryCoverage: 0.65,
      topCities: ["San Francisco", "Los Angeles"],
      countries: ["United States", "Germany"],
      experienceLevels: ["Senior", "Junior", "Staff"],
      employmentTypes: ["full-time", "contract"],
      locationKinds: ["onsite", "remote", "hybrid"],
      sourceNames: ["searchnapply", "fixture"],
      sourceShares: [0.98, 0.02],
    };
    const client = {
      query: async () => ({ json: async () => [row] }),
    } as unknown as ClickHouseClient;
    const analytics = createAnalytics({ client, table: "postings_test" });

    const c = await analytics.corpusSummary();
    expect(c.total).toBe(3488);
    expect(c.freshestAt).toBe("2026-07-18 06:00:00");
    expect(c.salaryCoverage).toBe(0.65);
    expect(c.topCities).toEqual(["San Francisco", "Los Angeles"]);
    expect(c.countries).toEqual(["United States", "Germany"]);
    expect(c.experienceLevels).toEqual(["Senior", "Junior", "Staff"]);
    expect(c.employmentTypes).toEqual(["full-time", "contract"]);
    expect(c.locationKinds).toEqual(["onsite", "remote", "hybrid"]);
    expect(c.sources).toEqual([
      { source: "searchnapply", share: 0.98 },
      { source: "fixture", share: 0.02 },
    ]);
  });
});

// Data-path role matching: a named role in a DATA query (count / breakdown / salary / list) resolves to
// canonical role name(s) and matches has(role_names, name) as the PRIMARY signal, with title ILIKE as the
// fallback for unclassified rows - the same canonical/title split the fit scorer uses, now in the data
// tools too. With NO resolved names it is title ILIKE only (byte-identical to before), so an empty
// taxonomy is a zero-regression no-op.
describe("data-path canonical role filter (buildTemplateSql + buildComposedSql)", () => {
  const CANONICAL =
    "(hasAny(arrayMap(rn -> lowerUTF8(rn), role_names), ['test engineer']) OR (empty(role_names) AND title ILIKE '%Test Engineer%'))";

  it("templates: a resolved role name keys off canonical has(role_names) with a title fallback", () => {
    const { sql } = buildTemplateSql(
      "salary_distribution",
      { role: "Test Engineer" },
      "postings",
      ["test engineer"],
    );
    expect(sql).toContain(CANONICAL);
  });

  it("templates: NO resolved names is title ILIKE only (no role_names machinery leaks)", () => {
    const { sql } = buildTemplateSql("salary_distribution", { role: "Test Engineer" }, "postings");
    expect(sql).toContain("title ILIKE '%Test Engineer%'");
    expect(sql).not.toContain("role_names");
  });

  it("composed: a resolved role name keys off canonical has(role_names) with a title fallback", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], role: "Test Engineer" },
      "postings",
      ["test engineer"],
    );
    expect(sql).toContain(CANONICAL);
  });

  it("composed: NO resolved names is byte-identical to the pre-roles call (forward-compat)", () => {
    const withEmpty = buildComposedSql({ measures: ["count"], role: "Test Engineer" }, "postings", []);
    const twoArg = buildComposedSql({ measures: ["count"], role: "Test Engineer" }, "postings");
    expect(withEmpty.sql).toBe(twoArg.sql);
    expect(twoArg.sql).not.toContain("role_names");
  });

  it("latest_postings accepts a role and filters by the canonical role (the LIST path)", () => {
    const { sql } = buildTemplateSql(
      "latest_postings",
      { role: "Test Engineer" },
      "postings",
      ["test engineer"],
    );
    expect(sql).toContain(CANONICAL);
  });
});

// The execute wiring: runQuery / runComposedQuery resolve a named role phrase to canonical name(s) over the
// corpus's own role dimension FIRST, then thread those names into the built SQL. A stub client records the
// queries so the resolve-then-build sequence is observable without a real ClickHouse.
describe("createAnalytics resolves a role phrase before building the data-path SQL", () => {
  function stubClient(resolvedNames: string[], captured: string[]): ClickHouseClient {
    return {
      query: async ({ query }: { query: string }) => {
        captured.push(query);
        const rows = query.includes("arrayJoin(role_names)")
          ? resolvedNames.map((name) => ({ name }))
          : query.includes("AS sampleN")
            ? [{ sampleN: 14, freshestAt: "2026-07-24 00:00:00" }]
            : [{ count: 14 }];
        return { json: async () => rows };
      },
    } as unknown as ClickHouseClient;
  }

  it("threads the resolved canonical names into the composed SQL (has(role_names) primary)", async () => {
    const captured: string[] = [];
    const analytics = createAnalytics({ client: stubClient(["test engineer"], captured), table: "postings" });
    await analytics.runComposedQuery({ measures: ["count"], role: "Test Engineer" });
    // The role-resolve query ran over the corpus role dimension.
    expect(captured.some((q) => q.includes("arrayJoin(role_names)"))).toBe(true);
    // A built (non-resolve) query carries the canonical has(role_names) match.
    expect(
      captured.some(
        (q) =>
          !q.includes("arrayJoin(role_names)") &&
          q.includes("hasAny(arrayMap(rn -> lowerUTF8(rn), role_names), ['test engineer'])"),
      ),
    ).toBe(true);
  });

  it("falls back to title ILIKE when the phrase resolves to nothing (empty taxonomy = no-op)", async () => {
    const captured: string[] = [];
    const analytics = createAnalytics({ client: stubClient([], captured), table: "postings" });
    await analytics.runComposedQuery({ measures: ["count"], role: "Test Engineer" });
    expect(
      captured.some(
        (q) =>
          !q.includes("arrayJoin(role_names)") &&
          q.includes("title ILIKE '%Test Engineer%'") &&
          !q.includes("hasAny"),
      ),
    ).toBe(true);
  });
});
