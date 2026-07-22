import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  buildComposedSql,
  buildSearchPostingsSql,
  buildTemplateSql,
  createAnalytics,
  seniorityBand,
} from "@shared/analytics";

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

  // Country is a chStr-equality filter on the two v1 templates the composed builder cannot
  // serve (latest_postings is an entity list; salary_distribution is the v1-only histogram shape).
  it("adds a country equality filter to latest_postings (same shape as city)", () => {
    const { sql } = buildTemplateSql("latest_postings", { country: "United States" }, "postings");
    expect(sql).toContain("country = 'United States'");
  });

  it("adds a country equality filter to salary_distribution", () => {
    const { sql } = buildTemplateSql("salary_distribution", { country: "Germany" }, "postings");
    expect(sql).toContain("country = 'Germany'");
  });

  it("escapes a quote in the country filter (no literal break-out)", () => {
    const { sql } = buildTemplateSql("latest_postings", { country: "Cote d'Ivoire" }, "postings");
    expect(sql).toContain("country = 'Cote d\\'Ivoire'");
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
    expect(sql).toContain("city = 'trail\\\\'");
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
    expect(sql).toContain("city IN ('Los Angeles', 'New York')");
    expect(sql).not.toContain("city = 'Berlin'"); // the single city loses to the list
  });

  it("still applies a single city when no cities list is present", () => {
    const { sql } = buildComposedSql({ measures: ["count"], city: "Berlin" }, "postings");
    expect(sql).toContain("city = 'Berlin'");
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
    expect(sql).toContain("country = 'United States'");
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
    expect(sql).toContain("city IN ('Los Angeles', 'New York')");
  });

  it("escapes a quote break-out inside the cities IN-list", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], cities: ["x' OR '1'='1"] },
      "postings",
    );
    expect(sql).toContain("city IN ('x\\' OR \\'1\\'=\\'1')");
  });

  // Escaping must be applied PER-ELEMENT across a multi-city list - a bug that escaped only cities[0]
  // (or joined the raw array before wrapping) would slip through. Probe an injection payload in a
  // NON-first position alongside a clean city.
  it("escapes a quote break-out in a non-first element of a multi-city IN-list", () => {
    const { sql } = buildComposedSql(
      { measures: ["count"], cities: ["Los Angeles", "x' OR '1'='1", "New York"] },
      "postings",
    );
    expect(sql).toContain("city IN ('Los Angeles', 'x\\' OR \\'1\\'=\\'1', 'New York')");
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
    // 2 * cityMatch
    expect(rowsSql).toContain("2 * (city IN ('Berlin', 'Munich'))");
    // 1 * (remoteOk AND remote)
    expect(rowsSql).toContain("1 * (location_kind = 'remote')");
    // 1 * salaryFloorMet (the posting ceiling reaches the requested floor; NULL salary is never a match)
    expect(rowsSql).toContain("1 * (salary_max IS NOT NULL AND salary_max >= 150000)");
  });

  it("orders by score DESC then publishedAt DESC, over the open set, keeping only matches (score > 0)", () => {
    const { rowsSql } = buildSearchPostingsSql(params, "postings");
    expect(rowsSql).toContain("FROM postings FINAL");
    expect(rowsSql).toContain("WHERE ingested_at = (SELECT max(ingested_at) FROM postings)");
    expect(rowsSql).toContain("WHERE score > 0");
    expect(rowsSql).toContain("ORDER BY score DESC, published_at DESC");
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
    expect(rowsSql).toContain("city IN ('y\\' OR \\'1\\'=\\'1')");
  });

  it("computes the meta over the matched set (total, freshestAt, dominant company)", () => {
    const { metaSql } = buildSearchPostingsSql(params, "postings");
    expect(metaSql).toContain("count() AS c");
    expect(metaSql).toContain("max(ingested_at) AS freshestAt");
    expect(metaSql).toContain("WHERE score > 0");
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
