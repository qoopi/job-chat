import { z } from "zod";
import type { ClickHouseClient } from "@clickhouse/client";
// Type-only import (erased at build): the scored OUTPUT row, NOT the profile type. The profile object
// never enters the CH path; the output row is fine, and `import type` pulls no runtime profile code in.
import type { ScoredPostingRow } from "@shared/insight";

// The analytics catalog: the only path from agent to ClickHouse; meta.sql is the EXACT executed SQL
// ("Show query" reveals it verbatim). SQL-INJECTION safety despite interpolation (the reveal needs the
// REAL SQL): Zod validates every param (enums -> fixed column names), chStr() escapes free-text as a CH
// string literal, and the read-only jobchat_ro user + row/time caps bound the blast radius.

const BUCKET_WIDTH = 20000; // salary histogram bucket width (currency units)

// Per-template row cap (the LIMIT); latest_postings uses its own `limit` param instead.
const LIMITS = {
  salary_distribution: 500,
  salary_compare: 10,
  postings_trend: 400,
  top_companies: 10,
  share_split: 20,
} as const;

const QUERY_SETTINGS = {
  max_execution_time: 5,
  max_result_rows: "10000",
  // Return UInt64 as JSON numbers, not strings (our counts are tiny; no precision risk).
  output_format_json_quote_64bit_integers: 0,
  // transform_null_in=1: CH's default (0) evaluates NULL IN (...) to NULL, not 0. The searchPostings city
  // score term sits inside the score arithmetic, so a NULL city would make score NULL and WHERE score > 0
  // silently DROP a strong match that just lists no city; =1 yields the intended 0 (live-proven).
  transform_null_in: 1,
} as const;

/** Escape a value as a ClickHouse single-quoted string literal (backslash-style escaping). */
function chStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Escape LIKE/ILIKE metacharacters (`%`, `_`) so a free-text value matches literally, not as wildcards.
 *  Applied BEFORE the `%...%` wrapping (the outer `%` stay wildcards); chStr then doubles the backslash. */
function likeEscape(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

function whereClause(filters: string[]): string {
  return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
}

// Case-insensitive categorical matching. ONE home: `eqCI`/`inCI` wrap lowerUTF8 around BOTH
// the column and the value so a filter value's casing never changes which rows match
// ("senior"/"Senior"/"SENIOR" are identical). All three query families (fixed templates, composed
// builder, searchPostings) route their categorical equality/IN through here. Only free-text categorical
// String columns pass through - experience_level, employment_type, city, region, country (company is
// already case-insensitive via ILIKE; location_kind is an Enum8 whose filter values are Zod-validated to
// the canonical lowercase names, so wrapping it would be a no-op needing an Enum->String cast).
// A function on a filter column forgoes primary-index / skip-index use
// (clickhouse-best-practices `schema-pk-filter-on-orderby` CRITICAL, `query-index-skipping-indices` HIGH),
// but that is MOOT here: none of these columns are in `postings`' ORDER BY (source, external_id) and the
// table carries no skip indices, so every categorical aggregate already full-scans the ~12k-row open set
// - lowerUTF8 per row on that scan costs nothing measurable. The value is still chStr-escaped inside the
// wrap, so the SQL-injection contract is unchanged.
function lowerCI(expr: string): string {
  return `lowerUTF8(${expr})`;
}
function eqCI(column: string, value: string): string {
  return `${lowerCI(column)} = ${lowerCI(chStr(value))}`;
}
function inCI(column: string, values: string[]): string {
  return `${lowerCI(column)} IN (${values.map((v) => lowerCI(chStr(v))).join(", ")})`;
}

function assemble(lines: string[]): string {
  return lines.filter((line) => line !== "").join("\n");
}

function roleFilter(role: string): string {
  return `title ILIKE ${chStr(`%${likeEscape(role)}%`)}`;
}

function trendWindow(table: string, days: number): string {
  return `published_at > (SELECT max(published_at) FROM ${table} FINAL) - INTERVAL ${days} DAY`;
}

/** Open-set predicate: keep only the latest ingest snapshot. Sound because one ingest run shares one
 *  `ingested_at`, so max() is that run's stamp. No FINAL: max(ingested_at) is dedup-invariant. */
function openSetFilter(table: string): string {
  return `ingested_at = (SELECT max(ingested_at) FROM ${table})`;
}

const SalaryDistributionParams = z
  .object({
    role: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
  })
  .strict();
const SalaryCompareParams = z
  .object({ role: z.string().min(1).optional(), cities: z.array(z.string().min(1)).length(2) })
  .strict();
const PostingsTrendParams = z
  .object({ days: z.number().int().positive().max(3650), role: z.string().min(1).optional() })
  .strict();
const TopCompaniesParams = z
  .object({ days: z.number().int().positive().max(3650).optional(), city: z.string().min(1).optional() })
  .strict();
const ShareSplitParams = z
  .object({ dimension: z.enum(["experience", "location_kind"]), role: z.string().min(1).optional() })
  .strict();
const LatestPostingsParams = z
  .object({
    company: z.string().min(1).optional(),
    level: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).default(20),
  })
  .strict();

// Exported so the tool input schemas wire from this one home.
export const TEMPLATE_PARAM_SCHEMAS = {
  salary_distribution: SalaryDistributionParams,
  salary_compare: SalaryCompareParams,
  postings_trend: PostingsTrendParams,
  top_companies: TopCompaniesParams,
  share_split: ShareSplitParams,
  latest_postings: LatestPostingsParams,
} as const;

export type TemplateName = keyof typeof TEMPLATE_PARAM_SCHEMAS;

export interface BuiltQuery {
  sql: string; // the main rows query (revealed by Show query)
  where: string; // the shared WHERE clause, reused for the sampleN/freshestAt meta query
  openSet: boolean; // whether the open-set predicate was applied (current-state read) - carried to meta
  // Newest-first + LIMIT keeps today and drops the oldest when the window exceeds the LIMIT; executeBuilt
  // reverses the rows for chronological display. Absent = the query's own order is the display order.
  reverse?: boolean;
  // Salary aggregate: filtered to the dominant salary_currency (never mixed), so meta resolves that currency.
  salary?: boolean;
}

/** Dominant-currency predicate: keep only the most common salary_currency among the matching salaried
 *  rows, so a median is never mixed-currency. `IN (... LIMIT 1)` not `=` so an empty set yields no rows. */
function dominantCurrencyFilter(table: string, baseFilters: string[]): string {
  const inner = whereClause([...baseFilters, "salary_currency IS NOT NULL"]);
  return `salary_currency IN (SELECT salary_currency FROM ${table} FINAL ${inner} GROUP BY salary_currency ORDER BY count() DESC, salary_currency ASC LIMIT 1)`;
}

/** Validate params (throws) and build the exact interpolated SQL for a template. Pure - unit-testable without a client. */
export function buildTemplateSql(name: TemplateName, rawParams: unknown, table: string): BuiltQuery {
  switch (name) {
    case "salary_distribution": {
      const p = SalaryDistributionParams.parse(rawParams);
      const filters = ["salary_min IS NOT NULL", "salary_max IS NOT NULL"];
      if (p.role) filters.push(roleFilter(p.role));
      if (p.city) filters.push(eqCI("city", p.city));
      if (p.country) filters.push(eqCI("country", p.country));
      filters.push(openSetFilter(table));
      filters.push(dominantCurrencyFilter(table, filters)); // single-currency salaried set only
      const where = whereClause(filters);
      const sql = assemble([
        "WITH salaried AS (",
        "  SELECT (salary_min + salary_max) / 2 AS salary",
        `  FROM ${table} FINAL`,
        `  ${where}`,
        ")",
        "SELECT",
        `  floor(salary / ${BUCKET_WIDTH}) * ${BUCKET_WIDTH} AS bucket,`,
        "  count() AS count,",
        "  round((SELECT quantileExact(0.5)(salary) FROM salaried)) AS median",
        "FROM salaried",
        "GROUP BY bucket",
        "ORDER BY bucket",
        `LIMIT ${LIMITS.salary_distribution}`,
      ]);
      return { sql, where, openSet: true, salary: true };
    }
    case "salary_compare": {
      const p = SalaryCompareParams.parse(rawParams);
      const filters = [
        "salary_min IS NOT NULL",
        "salary_max IS NOT NULL",
        inCI("city", p.cities),
      ];
      if (p.role) filters.push(roleFilter(p.role));
      filters.push(openSetFilter(table));
      filters.push(dominantCurrencyFilter(table, filters)); // compare within one currency only
      const where = whereClause(filters);
      const sql = assemble([
        "SELECT",
        "  city,",
        "  round(quantileExact(0.5)((salary_min + salary_max) / 2)) AS median,",
        "  count() AS n",
        `FROM ${table} FINAL`,
        where,
        "GROUP BY city",
        "ORDER BY median DESC, city ASC",
        `LIMIT ${LIMITS.salary_compare}`,
      ]);
      return { sql, where, openSet: true, salary: true };
    }
    case "postings_trend": {
      const p = PostingsTrendParams.parse(rawParams);
      const filters = [trendWindow(table, p.days)];
      if (p.role) filters.push(roleFilter(p.role));
      const where = whereClause(filters);
      const sql = assemble([
        "SELECT",
        "  toDate(published_at) AS day,",
        "  count() AS count",
        `FROM ${table} FINAL`,
        where,
        "GROUP BY day",
        // Newest-first + LIMIT keeps recent days (ASC LIMIT would drop TODAY); executeBuilt reverses for display.
        "ORDER BY day DESC",
        `LIMIT ${LIMITS.postings_trend}`,
      ]);
      // Trend keeps full history (closed postings are legitimate history) - no open-set predicate.
      return { sql, where, openSet: false, reverse: true };
    }
    case "top_companies": {
      const p = TopCompaniesParams.parse(rawParams);
      const filters: string[] = [];
      if (p.days !== undefined) filters.push(trendWindow(table, p.days));
      if (p.city) filters.push(eqCI("city", p.city));
      // Current-state only when unwindowed; a days window is a historical read.
      const openSet = p.days === undefined;
      if (openSet) filters.push(openSetFilter(table));
      const where = whereClause(filters);
      const sql = assemble([
        "SELECT",
        "  company,",
        "  count() AS count",
        `FROM ${table} FINAL`,
        where,
        "GROUP BY company",
        "ORDER BY count DESC, company ASC",
        `LIMIT ${LIMITS.top_companies}`,
      ]);
      return { sql, where, openSet };
    }
    case "share_split": {
      const p = ShareSplitParams.parse(rawParams);
      const dimColumn = p.dimension === "experience" ? "experience_level" : "location_kind";
      const filters: string[] = [];
      if (p.role) filters.push(roleFilter(p.role));
      filters.push(openSetFilter(table));
      const where = whereClause(filters);
      // toString() so location_kind (Enum8) serializes/sorts by NAME, not its int.
      const sql = assemble([
        "SELECT",
        `  toString(${dimColumn}) AS label,`,
        "  count() AS count",
        `FROM ${table} FINAL`,
        where,
        "GROUP BY label",
        "ORDER BY count DESC, label ASC",
        `LIMIT ${LIMITS.share_split}`,
      ]);
      return { sql, where, openSet: true };
    }
    case "latest_postings": {
      const p = LatestPostingsParams.parse(rawParams);
      const filters: string[] = [];
      if (p.company) filters.push(`company ILIKE ${chStr(`%${likeEscape(p.company)}%`)}`);
      if (p.level) filters.push(eqCI("experience_level", p.level));
      if (p.country) filters.push(eqCI("country", p.country));
      filters.push(openSetFilter(table));
      const where = whereClause(filters);
      const sql = assemble([
        "SELECT",
        "  title,",
        "  company,",
        "  city,",
        "  experience_level,",
        "  salary_min,",
        "  salary_max,",
        "  salary_currency,",
        "  toString(published_at) AS published_at,",
        "  apply_url",
        `FROM ${table} FINAL`,
        where,
        "ORDER BY published_at DESC, external_id DESC",
        `LIMIT ${p.limit}`,
      ]);
      return { sql, where, openSet: true };
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown analytics template: ${String(exhaustive)}`);
    }
  }
}

// query_postings' data layer: a whitelisted aggregate; same SQL-injection safety contract as the templates.

const COMPOSED_MEASURES = ["count", "median_salary", "p25_salary", "p75_salary"] as const;
const COMPOSED_DIMENSIONS = [
  "company",
  "city",
  "region",
  "country",
  "experience_level",
  "employment_type",
  "location_kind",
  "title",
] as const;
const TIME_BUCKETS = ["day", "week", "month"] as const;

type ComposedMeasure = (typeof COMPOSED_MEASURES)[number];
type ComposedDimension = (typeof COMPOSED_DIMENSIONS)[number];
type TimeBucket = (typeof TIME_BUCKETS)[number];

const isUnique = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** query_postings input schema (exported so the tool wires from one home). Structural validation only -
 *  the cross-field sort check lives in buildComposedSql. */
export const ComposedQueryParams = z
  .object({
    measures: z
      .array(z.enum(COMPOSED_MEASURES))
      .min(1)
      .max(2)
      .refine(isUnique, "measures must be unique"),
    dimensions: z
      .array(z.enum(COMPOSED_DIMENSIONS))
      .max(2)
      .refine(isUnique, "dimensions must be unique")
      .default([]),
    bucket: z.enum(TIME_BUCKETS).optional(),
    role: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    // Multi-city IN-list. When both `cities` and `city` are set, `cities` WINS (the follow-up inheritance
    // rule replaces a filter, never AND-s it into a possibly-empty intersection - see buildComposedSql).
    cities: z.array(z.string().min(1)).min(1).max(20).optional(),
    region: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    experience_level: z.string().min(1).optional(),
    employment_type: z.string().min(1).optional(),
    location_kind: z.enum(["onsite", "remote", "hybrid"]).optional(),
    days: z.number().int().positive().max(3650).optional(),
    // Capped (bounded-number discipline); the ceiling stays well below the 1e21 scientific-notation edge.
    min_salary: z.number().int().positive().max(1_000_000_000).optional(),
    max_salary: z.number().int().positive().max(1_000_000_000).optional(),
    // `.strict()` on the inner sort object too: reject an unknown key, don't strip it.
    sort: z.object({ by: z.string().min(1), dir: z.enum(["asc", "desc"]) }).strict().optional(),
    limit: z.number().int().positive().max(50).default(20),
  })
  .strict();
export type ComposedQuery = z.infer<typeof ComposedQueryParams>;

const SALARY_MEASURES: ReadonlySet<ComposedMeasure> = new Set([
  "median_salary",
  "p25_salary",
  "p75_salary",
]);

function measureSelect(m: ComposedMeasure): string {
  switch (m) {
    case "count":
      return "count() AS count";
    case "median_salary":
      return "round(quantileExact(0.5)((salary_min + salary_max) / 2)) AS median_salary";
    case "p25_salary":
      return "round(quantileExact(0.25)((salary_min + salary_max) / 2)) AS p25_salary";
    case "p75_salary":
      return "round(quantileExact(0.75)((salary_min + salary_max) / 2)) AS p75_salary";
  }
}

interface DimensionSpec {
  alias: string; // the output column / stable Recharts key
  select: string; // the SELECT-list expression (aliased)
  group: string; // the GROUP BY / ORDER BY expression (never the bare alias)
}

function dimensionSpec(d: ComposedDimension): DimensionSpec {
  // location_kind (Enum8): toString to serialize/order by NAME. GROUP/ORDER by the raw expression, not
  // the alias, so the alias never shadows the same-named column.
  if (d === "location_kind") {
    return {
      alias: "location_kind",
      select: "toString(location_kind) AS location_kind",
      group: "toString(location_kind)",
    };
  }
  return { alias: d, select: d, group: d };
}

function bucketSpec(b: TimeBucket): DimensionSpec {
  const fn = b === "day" ? "toStartOfDay" : b === "week" ? "toStartOfWeek" : "toStartOfMonth";
  const expr = `${fn}(published_at)`;
  return { alias: "bucket", select: `${expr} AS bucket`, group: expr };
}

/** Validate composed params (throws) and build the exact interpolated SQL. Pure, like buildTemplateSql.
 *  Deterministic ORDER BY (sort spec, then remaining dimensions ASC); open-set unless a `days` window. */
export function buildComposedSql(rawParams: unknown, table: string): BuiltQuery {
  const p = ComposedQueryParams.parse(rawParams);

  const dims: DimensionSpec[] = p.dimensions.map(dimensionSpec);
  if (p.bucket) dims.push(bucketSpec(p.bucket));

  // Default sort: chronological when bucketed, else the first measure DESC. Key must be a selected measure/dim.
  const sortable = new Set<string>([...p.measures, ...dims.map((d) => d.alias)]);
  const sort = p.sort ?? { by: p.bucket ? "bucket" : p.measures[0], dir: p.bucket ? "asc" : "desc" };
  if (!sortable.has(sort.by)) {
    throw new Error(`sort.by must be a selected measure or dimension: ${sort.by}`);
  }

  const isSalary = p.measures.some((m) => SALARY_MEASURES.has(m));
  const filters: string[] = [];
  if (isSalary) {
    filters.push("salary_min IS NOT NULL", "salary_max IS NOT NULL");
  }
  if (p.role) filters.push(roleFilter(p.role));
  if (p.company) filters.push(`company ILIKE ${chStr(`%${likeEscape(p.company)}%`)}`);
  // `cities` WINS over a coexisting single `city` (follow-up inheritance replaces, never intersects).
  if (p.cities) filters.push(inCI("city", p.cities));
  else if (p.city) filters.push(eqCI("city", p.city));
  if (p.region) filters.push(eqCI("region", p.region));
  if (p.country) filters.push(eqCI("country", p.country));
  if (p.experience_level) filters.push(eqCI("experience_level", p.experience_level));
  if (p.employment_type) filters.push(eqCI("employment_type", p.employment_type));
  // location_kind is an Enum8 with Zod-validated canonical lowercase values - a direct equality (no
  // lowerUTF8 wrap, which would need an Enum->String cast for a no-op) is correct here.
  if (p.location_kind) filters.push(`location_kind = ${chStr(p.location_kind)}`);
  if (p.min_salary !== undefined) filters.push(`(salary_min + salary_max) / 2 >= ${p.min_salary}`);
  if (p.max_salary !== undefined) filters.push(`(salary_min + salary_max) / 2 <= ${p.max_salary}`);
  const openSet = p.days === undefined;
  if (openSet) filters.push(openSetFilter(table));
  else filters.push(trendWindow(table, p.days!));
  // Salary measures use the dominant currency only; added last so its subquery scopes over all prior filters.
  if (isSalary) filters.push(dominantCurrencyFilter(table, filters));
  const where = whereClause(filters);

  const sortExpr = p.measures.includes(sort.by as ComposedMeasure)
    ? sort.by
    : dims.find((d) => d.alias === sort.by)!.group;
  // A pure chronological trend (bucket only, default bucket-ASC) keeps the NEWEST buckets past the LIMIT:
  // order DESC + LIMIT, then reverse for display. A bucketed cross-tab is a table, keeps its order.
  const chronologicalTrend =
    p.bucket !== undefined && p.dimensions.length === 0 && sort.by === "bucket" && sort.dir === "asc";
  const primaryDir = chronologicalTrend ? "DESC" : sort.dir.toUpperCase();
  const orderParts = [`${sortExpr} ${primaryDir}`];
  for (const d of dims) {
    if (d.alias === sort.by) continue;
    orderParts.push(`${d.group} ASC`);
  }

  const selectList = [...dims.map((d) => d.select), ...p.measures.map(measureSelect)];
  const sql = assemble([
    "SELECT",
    "  " + selectList.join(",\n  "),
    `FROM ${table} FINAL`,
    where,
    dims.length ? `GROUP BY ${dims.map((d) => d.group).join(", ")}` : "",
    `ORDER BY ${orderParts.join(", ")}`,
    `LIMIT ${p.limit}`,
  ]);
  return { sql, where, openSet, reverse: chronologicalTrend, salary: isSalary };
}

// The deterministic searchPostings scorer: whitelisted, interpolated, scored SQL over the open set (same
// SQL-injection safety as the templates). SECURITY: no profile type/field reaches here - only DERIVED
// filter VALUES (title terms, cities, a band string).

export const SENIORITY_BANDS = ["junior", "mid", "senior", "lead"] as const;
export type SeniorityBand = (typeof SENIORITY_BANDS)[number];

/** Free-text experience_level -> band; FIRST match wins, unmatched -> "". Keyword substrings (not an exact
 *  set) so it is robust to case variants and unseen values. One home: seniorityBand + seniorityBandSql. */
const BAND_KEYWORDS: { band: SeniorityBand; keywords: string[] }[] = [
  { band: "junior", keywords: ["junior", "intern", "entry", "graduate", "trainee"] },
  { band: "senior", keywords: ["senior"] },
  { band: "lead", keywords: ["lead", "staff", "principal", "executive", "director", "head"] },
  { band: "mid", keywords: ["mid", "intermediate"] },
];

/** The band a free-text experience level maps to (case-insensitive), or "" when none matches. */
export function seniorityBand(text: string): SeniorityBand | "" {
  const t = text.toLowerCase();
  for (const { band, keywords } of BAND_KEYWORDS)
    if (keywords.some((k) => t.includes(k))) return band;
  return "";
}

/** Senior+ = the senior or lead band, from BAND_KEYWORDS' one home (the shortlist "Senior+" filter,
 *  matching what the scorer counts - so executive/head/director qualify). */
export function isSeniorPlusBand(text: string): boolean {
  const band = seniorityBand(text);
  return band === "senior" || band === "lead";
}

/** SQL band expression: a multiIf mirroring seniorityBand (ILIKE, case-insensitive); unmatched -> "". */
function seniorityBandSql(column: string): string {
  const clauses = BAND_KEYWORDS.map(({ band, keywords }) => {
    // likeEscape each keyword (defense-in-depth) so a future `_`/`%` matches literally, not as a wildcard.
    const cond = keywords.map((k) => `${column} ILIKE ${chStr(`%${likeEscape(k)}%`)}`).join(" OR ");
    return `${cond}, ${chStr(band)}`;
  });
  return `multiIf(${clauses.join(", ")}, '')`;
}

/** searchPostings params: DERIVED filter VALUES only - the profile object never crosses this boundary.
 *  Strict (unknown key rejected). Analytics-internal; the search_postings TOOL input is a narrower schema. */
const SearchPostingsParams = z
  .object({
    titleTerms: z.array(z.string().min(1)).max(10).default([]),
    experience: z.string().min(1).nullish(),
    cities: z.array(z.string().min(1)).max(20).default([]),
    // "at company X for me": the named companies constrain the scored set as a HARD filter (never a score
    // addend). Capped at 5; empty means no company constraint (rank the whole open set).
    companies: z.array(z.string().min(1)).max(5).default([]),
    remoteOk: z.boolean().optional(),
    salaryMin: z.number().int().positive().max(1_000_000_000).optional(),
    limit: z.number().int().positive().max(50).default(10),
  })
  .strict();
type SearchPostingsQuery = z.infer<typeof SearchPostingsParams>;

/** The FIXED score formula:
 *    3*min(titleTermHits,2) + 2*experienceMatch + 2*cityMatch + 1*(remoteOk AND remote) + 1*salaryFloorMet
 *  An absent term contributes literal `0` so the formula stays whole; a NULL salary is never a match. */
function scoreExpr(p: SearchPostingsQuery): string {
  const titleHits =
    p.titleTerms.length > 0
      ? `least(${p.titleTerms.map((t) => `(title ILIKE ${chStr(`%${likeEscape(t)}%`)})`).join(" + ")}, 2)`
      : "0";
  const band = p.experience ? seniorityBand(p.experience) : "";
  const expMatch = band ? `(${seniorityBandSql("experience_level")} = ${chStr(band)})` : "0";
  const cityMatch = p.cities.length > 0 ? `(${inCI("city", p.cities)})` : "0";
  const remoteMatch = p.remoteOk ? "(location_kind = 'remote')" : "0";
  const salaryMatch =
    p.salaryMin !== undefined
      ? `(salary_max IS NOT NULL AND salary_max >= ${p.salaryMin})`
      : "0";
  return `3 * ${titleHits} + 2 * ${expMatch} + 2 * ${cityMatch} + 1 * ${remoteMatch} + 1 * ${salaryMatch}`;
}

/** Build the rows + meta SQL for searchPostings (pure, unit-testable). Score computed once in an inner
 *  subquery so the outer filters (score > 0) and orders by the alias. Open set only. */
export function buildSearchPostingsSql(
  rawParams: unknown,
  table: string,
): { rowsSql: string; metaSql: string } {
  const p = SearchPostingsParams.parse(rawParams);
  const score = scoreExpr(p);
  const openSet = openSetFilter(table);
  // A company scope narrows the ranked set to those companies only, applied alongside the open-set predicate
  // in BOTH inner queries so the honest total counts just the named companies.
  const scope = p.companies.length > 0 ? `${openSet} AND ${inCI("company", p.companies)}` : openSet;
  const rowsSql = assemble([
    "SELECT",
    "  title,",
    "  company,",
    "  city,",
    "  remote,",
    "  salary_min,",
    "  salary_max,",
    "  experience,",
    "  publishedAt,",
    "  apply_url,",
    "  score",
    "FROM (",
    "  SELECT",
    "    title,",
    "    company,",
    "    city,",
    "    (location_kind = 'remote') AS remote,",
    "    salary_min,",
    "    salary_max,",
    "    experience_level AS experience,",
    "    toString(published_at) AS publishedAt,",
    "    published_at,",
    "    apply_url,",
    `    ${score} AS score`,
    `  FROM ${table} FINAL`,
    `  WHERE ${scope}`,
    ")",
    "WHERE score > 0",
    // Deterministic tie-break within equal scores - salary-listed rows first, then
    // freshest. Stops a listed-salary US row sinking below an unlisted India row on a score tie.
    "ORDER BY score DESC, (salary_min IS NOT NULL OR salary_max IS NOT NULL) DESC, published_at DESC",
    `LIMIT ${p.limit}`,
  ]);
  const metaSql = assemble([
    "SELECT",
    "  company,",
    "  count() AS c,",
    "  max(ingested_at) AS freshestAt",
    "FROM (",
    "  SELECT",
    "    company,",
    "    ingested_at,",
    `    ${score} AS score`,
    `  FROM ${table} FINAL`,
    `  WHERE ${scope}`,
    ")",
    "WHERE score > 0",
    "GROUP BY company",
    "ORDER BY c DESC, company ASC",
  ]);
  return { rowsSql, metaSql };
}

/** searchPostings result: scored rows (matches only), the pre-limit `total`, and dominance/freshness meta. */
export interface SearchPostingsResult {
  rows: ScoredPostingRow[];
  total: number;
  meta: { freshestAt: string; topCompany: string; topShare: number };
}

export interface QueryResult {
  sql: string;
  rows: Record<string, unknown>[];
  // `openSet` present only on a current-state read; `currency` only on a salary aggregate. Both optional,
  // never default-injected (every persisted payload stays valid).
  meta: { sampleN: number; freshestAt: string; openSet?: boolean; currency?: string };
}

/** The corpus shape (current open set) so the agent can be honest about scope; shares are 0..1 fractions. */
export interface CoverageProfile {
  total: number; // open postings
  distinctCompanies: number;
  topCompany: string;
  topCompanyShare: number; // topCompany's share of `total` (0..1)
  freshestAt: string; // max(ingested_at), CH text form
  salaryCoverage: number; // fraction of postings carrying a salary range (0..1)
}

/** The compact "what the live data contains" summary for the per-conversation CORPUS note:
 *  size, snapshot, source mix, top cities, countries, and the canonical (most-frequent casing) values of
 *  each free-text categorical dimension, plus salary coverage. Rendered to text in trigger/run.ts. */
export interface CorpusSummary {
  total: number; // open postings
  freshestAt: string; // max(ingested_at), CH text form (the snapshot age source)
  salaryCoverage: number; // fraction of postings carrying a salary range (0..1)
  sources: { source: string; share: number }[]; // source mix, top-first, shares 0..1
  topCities: string[]; // up to 15, most-frequent first
  countries: string[]; // top-40 country sample, most-frequent first
  experienceLevels: string[]; // canonical spellings (most frequent casing per value), most-frequent first
  employmentTypes: string[];
  locationKinds: string[];
}

/** The corpus summary query: ONE read over the current open set. Pure/unit-testable like the
 *  other builders. Free-text categorical values dedupe by lowerUTF8 group and pick the most frequent
 *  casing (argMax over per-casing counts) so "Senior"/"senior" collapse to one canonical spelling; source
 *  names + shares come back as parallel arrays (identical ORDER BY) to avoid tuple serialization. */
export function buildCorpusSql(table: string): string {
  const from = `FROM ${table} FINAL`;
  const open = `WHERE ${openSetFilter(table)}`;
  // Distinct non-empty values of a free-text column, canonical casing first (argMax over per-casing
  // counts within each lowercased group), ordered by group frequency then value.
  const canonical = (col: string): string =>
    `(SELECT groupArray(v) FROM (SELECT argMax(${col}, c) AS v FROM (SELECT ${col}, count() AS c ${from} ${open} AND ${col} != '' GROUP BY ${col}) GROUP BY lowerUTF8(${col}) ORDER BY sum(c) DESC, v ASC))`;
  // Top-N non-null values of a nullable string column, most-frequent first.
  const topValues = (col: string, limit: number): string =>
    `(SELECT groupArray(${col}) FROM (SELECT ${col} ${from} ${open} AND ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY count() DESC, ${col} ASC LIMIT ${limit}))`;
  return assemble([
    "SELECT",
    "  count() AS total,",
    "  toString(max(ingested_at)) AS freshestAt,",
    "  round(countIf(salary_min IS NOT NULL AND salary_max IS NOT NULL) / count(), 4) AS salaryCoverage,",
    `  ${topValues("city", 15)} AS topCities,`,
    `  ${topValues("country", 40)} AS countries,`,
    `  ${canonical("experience_level")} AS experienceLevels,`,
    `  ${canonical("employment_type")} AS employmentTypes,`,
    `  (SELECT groupArray(v) FROM (SELECT toString(location_kind) AS v ${from} ${open} GROUP BY location_kind ORDER BY count() DESC, v ASC)) AS locationKinds,`,
    `  (SELECT groupArray(source) FROM (SELECT source ${from} ${open} GROUP BY source ORDER BY count() DESC, source ASC LIMIT 8)) AS sourceNames,`,
    `  (SELECT groupArray(sh) FROM (SELECT round(count() / (SELECT count() ${from} ${open}), 4) AS sh, count() AS c ${from} ${open} GROUP BY source ORDER BY c DESC, source ASC LIMIT 8)) AS sourceShares`,
    from,
    open,
  ]);
}

export interface Analytics {
  runQuery(name: TemplateName, params: unknown): Promise<QueryResult>;
  // Execution seam for query_postings; tools receive Analytics, never a raw client.
  runComposedQuery(params: unknown): Promise<QueryResult>;
  /** Profile-driven scored selection; params are DERIVED filter VALUES only (never the profile object). */
  searchPostings(params: unknown): Promise<SearchPostingsResult>;
  /** Corpus shape for the DATA SCOPE note. Memoized on the per-process analytics singleton (once per isolate,
   *  not per turn); only a fulfilled result is cached, a transient failure is retried. */
  coverageProfile(): Promise<CoverageProfile>;
  /** The compact corpus summary for the per-conversation CORPUS note. One read, NOT memoized
   *  here - the per-conversation memo lives in trigger/run.ts so a NEW conversation gets fresh facts. */
  corpusSummary(): Promise<CorpusSummary>;
}

/** Build the analytics catalog over a client. Production injects the read-only `jobchat_ro` user reading
 *  `postings`; tests inject a writer client + `postings_test` so expected numbers are stable. */
export function createAnalytics(config: { client: ClickHouseClient; table?: string }): Analytics {
  const table = config.table ?? "postings";
  const { client } = config;

  // Rows query + meta query over the SAME `where`, so sampleN matches the set the rows came from.
  async function executeBuilt(built: BuiltQuery): Promise<QueryResult> {
    // A salary aggregate also resolves its dominant currency (any() over the single-currency set).
    const metaSelect = ["  count() AS sampleN", "  max(ingested_at) AS freshestAt"];
    if (built.salary) metaSelect.push("  any(salary_currency) AS currency");
    const metaSql = assemble(["SELECT", metaSelect.join(",\n"), `FROM ${table} FINAL`, built.where]);

    // Fire rows + meta concurrently (max- not sum-latency). Promise.all handles BOTH rejections up front, so
    // one query failing never leaves the sibling as an unhandled rejection.
    const [fetched, metaRow] = await Promise.all([
      client
        .query({ query: built.sql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<Record<string, unknown>>()),
      client
        .query({ query: metaSql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<{ sampleN: number; freshestAt: string; currency?: string }>())
        .then((metaRows) => metaRows[0]),
    ]);

    // Reverse a newest-first trend slice to chronological order (fetched is fresh from json(), in-place is safe).
    const rows = built.reverse ? fetched.reverse() : fetched;

    return {
      sql: built.sql,
      rows,
      meta: {
        sampleN: Number(metaRow.sampleN),
        freshestAt: String(metaRow.freshestAt),
        ...(built.openSet ? { openSet: true } : {}),
        ...(built.salary && metaRow.currency ? { currency: String(metaRow.currency) } : {}),
      },
    };
  }

  // Memoized for the PROCESS (the analytics singleton lives across conversations), computed once per isolate,
  // not per turn. A REJECTED promise is NOT cached - a transient CH error must not poison the memo.
  let coverageCache: Promise<CoverageProfile> | undefined;
  async function computeCoverage(): Promise<CoverageProfile> {
    const openSet = openSetFilter(table);
    const sql = assemble([
      "SELECT",
      "  count() AS total,",
      "  uniqExact(company) AS distinctCompanies,",
      "  max(ingested_at) AS freshestAt,",
      "  round(countIf(salary_min IS NOT NULL AND salary_max IS NOT NULL) / count(), 4) AS salaryCoverage,",
      `  (SELECT company FROM ${table} FINAL WHERE ${openSet} GROUP BY company ORDER BY count() DESC, company ASC LIMIT 1) AS topCompany,`,
      `  (SELECT count() FROM ${table} FINAL WHERE ${openSet} GROUP BY company ORDER BY count() DESC, company ASC LIMIT 1) AS topCompanyCount`,
      `FROM ${table} FINAL`,
      `WHERE ${openSet}`,
    ]);
    const rs = await client.query({ query: sql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS });
    const [row] = await rs.json<{
      total: number;
      distinctCompanies: number;
      freshestAt: string;
      salaryCoverage: number;
      topCompany: string | null;
      topCompanyCount: number;
    }>();
    const total = Number(row.total);
    return {
      total,
      distinctCompanies: Number(row.distinctCompanies),
      topCompany: String(row.topCompany ?? ""),
      topCompanyShare: total > 0 ? Number(row.topCompanyCount) / total : 0,
      freshestAt: String(row.freshestAt),
      salaryCoverage: Number(row.salaryCoverage),
    };
  }

  // Rows + per-company match-count meta concurrently, then map rows / reduce meta. NULL/empty city -> null,
  // remote UInt8 -> boolean; a 0-match query returns rows=[] and total=0 (the honest no-match state).
  async function searchPostings(rawParams: unknown): Promise<SearchPostingsResult> {
    const { rowsSql, metaSql } = buildSearchPostingsSql(rawParams, table);
    const [rawRows, metaRows] = await Promise.all([
      client
        .query({ query: rowsSql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<Record<string, unknown>>()),
      client
        .query({ query: metaSql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<{ company: string; c: number; freshestAt: string }>()),
    ]);
    const rows: ScoredPostingRow[] = rawRows.map((r) => ({
      title: String(r.title),
      company: String(r.company),
      city: r.city == null || r.city === "" ? null : String(r.city),
      remote: Number(r.remote) === 1,
      salaryMin: r.salary_min == null ? null : Number(r.salary_min),
      salaryMax: r.salary_max == null ? null : Number(r.salary_max),
      experience: String(r.experience),
      publishedAt: String(r.publishedAt),
      applyUrl: r.apply_url == null ? "" : String(r.apply_url),
      score: Number(r.score),
    }));
    const total = metaRows.reduce((sum, m) => sum + Number(m.c), 0);
    const top = metaRows[0]; // ordered c DESC, company ASC - the dominant company
    const freshestAt = metaRows.reduce(
      (f, m) => (String(m.freshestAt) > f ? String(m.freshestAt) : f),
      "",
    );
    return {
      rows,
      total,
      meta: {
        freshestAt,
        topCompany: top ? String(top.company) : "",
        topShare: total > 0 && top ? Number(top.c) / total : 0,
      },
    };
  }

  // One corpus-summary read, parsed into CorpusSummary. NOT memoized here (unlike coverageProfile): the
  // per-conversation memo lives in trigger/run.ts, so each NEW conversation re-fetches fresh corpus facts.
  async function computeCorpus(): Promise<CorpusSummary> {
    const sql = buildCorpusSql(table);
    const rs = await client.query({ query: sql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS });
    const [row] = await rs.json<{
      total: number;
      freshestAt: string;
      salaryCoverage: number;
      topCities: string[];
      countries: string[];
      experienceLevels: string[];
      employmentTypes: string[];
      locationKinds: string[];
      sourceNames: string[];
      sourceShares: number[];
    }>();
    const names = row.sourceNames ?? [];
    const shares = row.sourceShares ?? [];
    return {
      total: Number(row.total),
      freshestAt: String(row.freshestAt),
      salaryCoverage: Number(row.salaryCoverage),
      topCities: (row.topCities ?? []).map(String),
      countries: (row.countries ?? []).map(String),
      experienceLevels: (row.experienceLevels ?? []).map(String),
      employmentTypes: (row.employmentTypes ?? []).map(String),
      locationKinds: (row.locationKinds ?? []).map(String),
      sources: names.map((s, i) => ({ source: String(s), share: Number(shares[i] ?? 0) })),
    };
  }

  return {
    runQuery: (name, params) => executeBuilt(buildTemplateSql(name, params, table)),
    runComposedQuery: (params) => executeBuilt(buildComposedSql(params, table)),
    searchPostings,
    // Cache only a FULFILLED result; on rejection clear the memo so the next call retries.
    coverageProfile: () =>
      (coverageCache ??= computeCoverage().catch((err) => {
        coverageCache = undefined;
        throw err;
      })),
    corpusSummary: () => computeCorpus(),
  };
}
