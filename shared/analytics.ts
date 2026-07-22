import { z } from "zod";
import type { ClickHouseClient } from "@clickhouse/client";
// Type-only import (erased at build): the scored row is the searchPostings return shape's one home.
// This is NOT the profile type/fields - AC-13 forbids the profile object in the CH path, never the
// scored OUTPUT row, and a `import type` pulls no runtime profile code into this module.
import type { ScoredPostingRow } from "@shared/insight";

// The analytics catalog: the ONLY path from the agent to ClickHouse. Six parameterized SQL templates
// (one per launch-question shape), each validated with Zod, read dedup-correct via FINAL, and bounded
// by a row LIMIT + max_execution_time. runQuery returns { sql, rows, meta } where `sql` is the exact
// statement executed - "Show query" reveals it verbatim.
//
// SQL-injection note: the usual rule is query_params, never string interpolation. Here the product
// requirement is the opposite - the reveal must show the REAL interpolated SQL, so meta.sql IS what
// executed. Safety is kept by (a) Zod validating every param (numbers/enums are typed; the enum
// dimension maps to a fixed column name, never an interpolated string), (b) chStr() escaping every
// free-text value as a ClickHouse string literal, and (c) the read-only jobchat_ro user + row/time
// caps bounding the blast radius.

const BUCKET_WIDTH = 20000; // salary histogram bucket width (currency units)

// Per-template row cap (the LIMIT). latest_postings uses its own `limit` param instead.
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
  // Return count()/UInt64 as JSON numbers (our counts are tiny; no precision risk) so callers get
  // numbers, not strings.
  output_format_json_quote_64bit_integers: 0,
  // Make `x IN (...)` return 0 (never NULL) for a NULL left-hand value. ClickHouse's DEFAULT
  // (transform_null_in = 0) evaluates `NULL IN ('a')` to NULL, NOT 0 (verified on the live server, v26.2).
  // The searchPostings scorer's cityMatch term `(city IN (...))` sits INSIDE the score arithmetic, so a
  // NULL there makes the whole `score` NULL and `WHERE score > 0` silently DROPS an otherwise-strong match
  // that merely lists no city. transform_null_in = 1 yields the intended "no city point" (0) instead. Safe
  // for every WHERE-clause IN too (NULL and 0 both exclude the row there), and the concrete city / currency
  // sets never contain NULL, so the NULL==NULL equality this setting also enables never fires.
  transform_null_in: 1,
} as const;

/** Escape a value as a ClickHouse single-quoted string literal (backslash-style escaping). */
function chStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Escape LIKE/ILIKE metacharacters (`%`, `_`) in a free-text search value so they match literally
 * instead of acting as wildcards (`a_b` must not match "axb", `50%` must not match anything after
 * "50"). Applied BEFORE the `%...%` substring wrapping - the outer `%` stay wildcards. ClickHouse's
 * LIKE escape char is backslash; chStr then doubles it for the string-literal layer.
 */
function likeEscape(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

function whereClause(filters: string[]): string {
  return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
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

/**
 * The open-set predicate: keep only rows from the latest ingest snapshot. Sound because every
 * row of an ingest run is stamped with one shared `ingested_at` (shared/ingest.ts), so the max is that
 * run's timestamp and equality selects exactly the current-state postings. No FINAL in the subquery:
 * max(ingested_at) is dedup-invariant (a superseded row always has an OLDER version), so FINAL would
 * only add cost. Applied to current-state reads; a days-windowed read keeps full history instead.
 */
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

// Exported so the agent's tool input schemas wire from the one home (DRY).
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
  // A chronological trend selects the NEWEST slice via `ORDER BY <time> DESC LIMIT n` so a window
  // wider than the LIMIT keeps today and drops the oldest (never the reverse). The rows come back
  // newest-first; executeBuilt reverses them so the display axis stays oldest -> newest. Absent = the
  // query's own order is the display order.
  reverse?: boolean;
  // A salary aggregate: it is filtered to the dominant salary_currency (never averaging mixed
  // currencies), so the meta query resolves that currency for the source line / money formatter.
  salary?: boolean;
}

/**
 * The dominant-currency predicate: keep only rows whose salary_currency is the most
 * common one among the salaried rows matching the SAME base filters, so a median/percentile is never
 * computed across mixed currencies. An `IN (... LIMIT 1)` (not `=`) so an empty salaried set yields no
 * rows gracefully rather than throwing on an empty scalar subquery.
 */
function dominantCurrencyFilter(table: string, baseFilters: string[]): string {
  const inner = whereClause([...baseFilters, "salary_currency IS NOT NULL"]);
  return `salary_currency IN (SELECT salary_currency FROM ${table} FINAL ${inner} GROUP BY salary_currency ORDER BY count() DESC, salary_currency ASC LIMIT 1)`;
}

/**
 * Validate params (throws on invalid) and build the exact interpolated SQL for a template.
 * Pure - no I/O - so the SQL and the param validation are unit-testable without a ClickHouse client.
 */
export function buildTemplateSql(name: TemplateName, rawParams: unknown, table: string): BuiltQuery {
  switch (name) {
    case "salary_distribution": {
      const p = SalaryDistributionParams.parse(rawParams);
      const filters = ["salary_min IS NOT NULL", "salary_max IS NOT NULL"];
      if (p.role) filters.push(roleFilter(p.role));
      if (p.city) filters.push(`city = ${chStr(p.city)}`);
      if (p.country) filters.push(`country = ${chStr(p.country)}`);
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
        `city IN (${p.cities.map((c) => chStr(c)).join(", ")})`,
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
        // Newest-first + LIMIT so a window wider than the cap keeps the recent days and drops the
        // oldest (ORDER BY day ASC LIMIT would drop TODAY); executeBuilt reverses for chronological display.
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
      if (p.city) filters.push(`city = ${chStr(p.city)}`);
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
      // toString() so location_kind (an Enum8) sorts and serializes as its name, not its int - the
      // tie order stays alphabetical and predictable across both dimensions.
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
      if (p.level) filters.push(`experience_level = ${chStr(p.level)}`);
      if (p.country) filters.push(`country = ${chStr(p.country)}`);
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
        "  toString(published_at) AS published_at",
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

// ---- Composable query builder (the everything-else path beside the six templates) ---------------
// query_postings' data layer: a whitelisted aggregate over the postings schema. Same
// safety contract as the templates - Zod validates every param, enums map to fixed column names, and
// chStr/likeEscape escape every free-text value; nothing here is a raw interpolated identifier.

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

/**
 * The query_postings input schema, exported like TEMPLATE_PARAM_SCHEMAS so the tool input wires
 * from the one home (DRY). Structural validation only (kept a strict ZodObject); the cross-field sort
 * check lives in buildComposedSql (still before any query runs).
 */
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
    // A multi-city filter for "openings in LA or NYC" (one number over both). Each value is
    // chStr-escaped into an IN-list; kept alongside single `city` for compat. Bounded so
    // the interpolated list stays small. SEMANTICS when both are set: `cities` WINS and the single `city`
    // is ignored (the FOLLOW-UP INHERITANCE rule replaces a filter, never AND-s it into a possibly-empty
    // intersection - see buildComposedSql).
    cities: z.array(z.string().min(1)).min(1).max(20).optional(),
    region: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    experience_level: z.string().min(1).optional(),
    employment_type: z.string().min(1).optional(),
    location_kind: z.enum(["onsite", "remote", "hybrid"]).optional(),
    days: z.number().int().positive().max(3650).optional(),
    // Capped like days/limit (bounded-number discipline); the ceiling also keeps the interpolated
    // integer well below the >= 1e21 scientific-notation edge. 1e9 is far above any real salary.
    min_salary: z.number().int().positive().max(1_000_000_000).optional(),
    max_salary: z.number().int().positive().max(1_000_000_000).optional(),
    // `.strict()` on the inner object too: an unknown key inside `sort` must be rejected, not stripped.
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
  // location_kind is an Enum8: toString so it serializes and orders by its NAME, not its int (same as
  // share_split). GROUP/ORDER by the raw expression, not the `location_kind` alias, so the alias can
  // never shadow the column of the same name.
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

/**
 * Validate composed params (throws on invalid) and build the exact interpolated SQL. Pure, like
 * buildTemplateSql - the SQL and the validation are unit-testable without a client. Deterministic
 * ORDER BY (the sort spec, then the remaining dimensions ASC) so results are stable, mirroring the
 * templates. Applies the open-set predicate unless a `days` window makes it a historical read.
 */
export function buildComposedSql(rawParams: unknown, table: string): BuiltQuery {
  const p = ComposedQueryParams.parse(rawParams);

  const dims: DimensionSpec[] = p.dimensions.map(dimensionSpec);
  if (p.bucket) dims.push(bucketSpec(p.bucket));

  // sort: default to chronological when time-bucketed (like postings_trend), else the first measure
  // descending (like top_companies). The key must name a selected measure or dimension.
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
  // `cities` (the multi-city IN-list) WINS over a coexisting single `city`: the FOLLOW-UP INHERITANCE rule
  // REPLACES a filter rather than AND-ing it, so a coexisting pair is a refinement to the list, not an
  // intersection (which could be empty). Smallest correct semantics: prefer cities, drop the single city
  // (documented on ComposedQueryParams.cities).
  if (p.cities) filters.push(`city IN (${p.cities.map((c) => chStr(c)).join(", ")})`);
  else if (p.city) filters.push(`city = ${chStr(p.city)}`);
  if (p.region) filters.push(`region = ${chStr(p.region)}`);
  if (p.country) filters.push(`country = ${chStr(p.country)}`);
  if (p.experience_level) filters.push(`experience_level = ${chStr(p.experience_level)}`);
  if (p.employment_type) filters.push(`employment_type = ${chStr(p.employment_type)}`);
  if (p.location_kind) filters.push(`location_kind = ${chStr(p.location_kind)}`);
  if (p.min_salary !== undefined) filters.push(`(salary_min + salary_max) / 2 >= ${p.min_salary}`);
  if (p.max_salary !== undefined) filters.push(`(salary_min + salary_max) / 2 <= ${p.max_salary}`);
  const openSet = p.days === undefined;
  if (openSet) filters.push(openSetFilter(table));
  else filters.push(trendWindow(table, p.days!));
  // Salary measures aggregate within the dominant currency only - never a mixed-currency median (added
  // last so its subquery scopes over the salaried + user + open-set/window filters).
  if (isSalary) filters.push(dominantCurrencyFilter(table, filters));
  const where = whereClause(filters);

  const sortExpr = p.measures.includes(sort.by as ComposedMeasure)
    ? sort.by
    : dims.find((d) => d.alias === sort.by)!.group;
  // A pure chronological trend (a time bucket, no other dimension, default bucket-ASC sort) must keep
  // the NEWEST buckets when the series is longer than the LIMIT: order bucket DESC + LIMIT here, then
  // reverse the rows for display (executeBuilt). A bucketed cross-tab (a dimension alongside the bucket)
  // is a table, not a trend, so it keeps its existing order.
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

// ---- Profile-driven selection scorer (searchPostings) -------------------------------------------
// The deterministic postings scorer behind the search_postings tool: a whitelisted, interpolated,
// scored query over the open set. Same safety contract as the templates (Zod-validated params, every
// free-text value chStr/likeEscape-escaped, enum/numeric params typed). The score is a FIXED formula;
// the seniority mapping is case-insensitive over the live experience_level values. No profile TYPE or
// FIELD reaches here (AC-13) - only DERIVED filter VALUES (title terms, cities, a band string) do.

/** The four profile seniority bands the free-text experience levels map to. */
export const SENIORITY_BANDS = ["junior", "mid", "senior", "lead"] as const;
export type SeniorityBand = (typeof SENIORITY_BANDS)[number];

/**
 * The keyword rules mapping a free-text experience_level to a band; FIRST match wins, unmatched -> "".
 * Derived from the live DISTINCT experience_level values (open set, recorded 2026-07-22):
 * "Senior" x1855, "Staff" x1086, "Mid" x417, "senior" x61, "" x28, "executive" x16, "mid-level" x12,
 * "internship" x7, "principal" x6. Keyword substrings (not an exact set) so the mapping is robust to
 * BOTH the case variants seen live AND unseen future values. ONE home: `seniorityBand` (the requested-
 * band normalization) and `seniorityBandSql` (the posting-side SQL) both derive from this.
 */
const BAND_KEYWORDS: { band: SeniorityBand; keywords: string[] }[] = [
  { band: "junior", keywords: ["junior", "intern", "entry", "graduate", "trainee"] },
  { band: "senior", keywords: ["senior"] },
  { band: "lead", keywords: ["lead", "staff", "principal", "executive", "director", "head"] },
  { band: "mid", keywords: ["mid", "intermediate"] },
];

/** The band a free-text experience level maps to (case-insensitive), or "" when none matches (no
 *  experience points). The requested experience is normalized through this before it is compared. */
export function seniorityBand(text: string): SeniorityBand | "" {
  const t = text.toLowerCase();
  for (const { band, keywords } of BAND_KEYWORDS)
    if (keywords.some((k) => t.includes(k))) return band;
  return "";
}

/** The SQL band expression over a column: a multiIf mirroring `seniorityBand`, using ILIKE so it is
 *  case-insensitive across the live case variants. Unmatched -> '' (never equals a requested band). */
function seniorityBandSql(column: string): string {
  const clauses = BAND_KEYWORDS.map(({ band, keywords }) => {
    // likeEscape each keyword (as roleFilter does) so a future keyword carrying `_`/`%` matches
    // literally, never as a wildcard - defense-in-depth; today's BAND_KEYWORDS are metacharacter-free.
    const cond = keywords.map((k) => `${column} ILIKE ${chStr(`%${likeEscape(k)}%`)}`).join(" OR ");
    return `${cond}, ${chStr(band)}`;
  });
  return `multiIf(${clauses.join(", ")}, '')`;
}

/**
 * The searchPostings params: DERIVED filter VALUES only (the server builds these from the stored
 * profile; the profile object never crosses this boundary). `experience` is a band string; `limit`
 * defaults to the interface's 10 and is hard-capped at 50 (the emitter raises it to 50 to carry all
 * matches up to that cap). Strict, so an unknown key is rejected, not stripped. Analytics-internal (the
 * search_postings TOOL input is a separate, narrower schema in trigger/tools.ts) - not exported.
 */
const SearchPostingsParams = z
  .object({
    titleTerms: z.array(z.string().min(1)).max(10).default([]),
    experience: z.string().min(1).nullish(),
    cities: z.array(z.string().min(1)).max(20).default([]),
    remoteOk: z.boolean().optional(),
    salaryMin: z.number().int().positive().max(1_000_000_000).optional(),
    limit: z.number().int().positive().max(50).default(10),
  })
  .strict();
type SearchPostingsQuery = z.infer<typeof SearchPostingsParams>;

/**
 * The FIXED score formula (implemented verbatim per the epic):
 *   3*min(titleTermHits,2) + 2*experienceMatch + 2*cityMatch + 1*(remoteOk AND remote) + 1*salaryFloorMet
 * A term whose param is absent contributes the literal `0`, so the formula stays whole. `salaryFloorMet`
 * = the posting's ceiling reaches the requested floor (a NULL salary is never a match).
 */
function scoreExpr(p: SearchPostingsQuery): string {
  const titleHits =
    p.titleTerms.length > 0
      ? `least(${p.titleTerms.map((t) => `(title ILIKE ${chStr(`%${likeEscape(t)}%`)})`).join(" + ")}, 2)`
      : "0";
  const band = p.experience ? seniorityBand(p.experience) : "";
  const expMatch = band ? `(${seniorityBandSql("experience_level")} = ${chStr(band)})` : "0";
  const cityMatch =
    p.cities.length > 0 ? `(city IN (${p.cities.map((c) => chStr(c)).join(", ")}))` : "0";
  const remoteMatch = p.remoteOk ? "(location_kind = 'remote')" : "0";
  const salaryMatch =
    p.salaryMin !== undefined
      ? `(salary_max IS NOT NULL AND salary_max >= ${p.salaryMin})`
      : "0";
  return `3 * ${titleHits} + 2 * ${expMatch} + 2 * ${cityMatch} + 1 * ${remoteMatch} + 1 * ${salaryMatch}`;
}

/**
 * Build the rows + meta SQL for searchPostings (pure, like buildTemplateSql/buildComposedSql - the SQL
 * and the param validation are unit-testable without a client). The score is computed once in an inner
 * subquery so the outer can filter (score > 0, matches only) and order by the alias cleanly. Meta is
 * the per-company match counts (reduced in TS to total + dominant company + freshestAt). Open set only
 * (current-state selection).
 */
export function buildSearchPostingsSql(
  rawParams: unknown,
  table: string,
): { rowsSql: string; metaSql: string } {
  const p = SearchPostingsParams.parse(rawParams);
  const score = scoreExpr(p);
  const openSet = openSetFilter(table);
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
    `    ${score} AS score`,
    `  FROM ${table} FINAL`,
    `  WHERE ${openSet}`,
    ")",
    "WHERE score > 0",
    "ORDER BY score DESC, published_at DESC",
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
    `  WHERE ${openSet}`,
    ")",
    "WHERE score > 0",
    "GROUP BY company",
    "ORDER BY c DESC, company ASC",
  ]);
  return { rowsSql, metaSql };
}

/** The searchPostings result: the scored rows (matches only, ordered), the pre-limit total for the
 *  "8 of 23" framing, and the dominance/freshness meta over the matched set. */
export interface SearchPostingsResult {
  rows: ScoredPostingRow[];
  total: number;
  meta: { freshestAt: string; topCompany: string; topShare: number };
}

export interface QueryResult {
  sql: string;
  rows: Record<string, unknown>[];
  // `openSet` is present (true) only on a current-state read; absent = full history. `currency`
  // is present only on a salary aggregate (the dominant currency it was filtered to). Both optional so
  // every persisted payload stays valid and neither is default-injected.
  meta: { sampleN: number; freshestAt: string; openSet?: boolean; currency?: string };
}

/**
 * The corpus shape: what the product is actually answering from, so the agent can be
 * honest about scope. Computed over the current open set (one snapshot). Shares (0..1) are fractions.
 */
export interface CoverageProfile {
  total: number; // open postings
  distinctCompanies: number;
  topCompany: string;
  topCompanyShare: number; // topCompany's share of `total` (0..1)
  freshestAt: string; // max(ingested_at), CH text form
  salaryCoverage: number; // fraction of postings carrying a salary range (0..1)
}

export interface Analytics {
  runQuery(name: TemplateName, params: unknown): Promise<QueryResult>;
  // The execution seam for query_postings (the query_postings tool calls this). Tools receive Analytics, never a raw
  // client, so the composed path must live on the interface too.
  runComposedQuery(params: unknown): Promise<QueryResult>;
  /**
   * The profile-driven selection: deterministic scored SQL over the open postings. Returns the matched
   * rows (score > 0) ordered by the FIXED formula, the pre-limit total, and the dominance/freshness
   * meta. Params are DERIVED filter VALUES only (never the profile object - AC-13). The search_postings
   * tool is the sole caller (like runComposedQuery is for query_postings).
   */
  searchPostings(params: unknown): Promise<SearchPostingsResult>;
  /**
   * The corpus shape for the DATA SCOPE prompt note. ONE cheap query, memoized on the
   * analytics instance - which is a per-process singleton (trigger/chat.ts), so it runs once per PROCESS
   * (isolate lifetime), never per turn. Only a fulfilled result is cached; a transient failure is retried
   * on the next call.
   */
  coverageProfile(): Promise<CoverageProfile>;
}

/**
 * Build the analytics catalog over a ClickHouse client. In production the client is the read-only
 * `jobchat_ro` user (createReadOnlyClient) reading `postings`; tests inject a writer client and a
 * `postings_test` table so expected numbers are stable regardless of live ingest.
 */
export function createAnalytics(config: { client: ClickHouseClient; table?: string }): Analytics {
  const table = config.table ?? "postings";
  const { client } = config;

  // Run a BuiltQuery: the rows query AND the sampleN/freshestAt meta query over the SAME `where` (so
  // the count matches the set the rows came from). Shared by both the template and composed paths.
  async function executeBuilt(built: BuiltQuery): Promise<QueryResult> {
    // A salary aggregate additionally resolves the dominant currency it was filtered to (any() over the
    // now single-currency set), so the source line / money formatter can disclose the real base.
    const metaSelect = ["  count() AS sampleN", "  max(ingested_at) AS freshestAt"];
    if (built.salary) metaSelect.push("  any(salary_currency) AS currency");
    const metaSql = assemble(["SELECT", metaSelect.join(",\n"), `FROM ${table} FINAL`, built.where]);

    // The rows and meta reads are independent (neither consumes the other's result), so fire them
    // concurrently - on the per-turn ClickHouse Cloud hot path this is max- not sum-latency.
    // Promise.all attaches a rejection handler to BOTH promises up front, so if one query fails the
    // sibling's rejection is still handled (no unhandled rejection) and the error surface matches the
    // old sequential path: the whole call rejects with whichever query failed first.
    const [fetched, metaRow] = await Promise.all([
      client
        .query({ query: built.sql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<Record<string, unknown>>()),
      client
        .query({ query: metaSql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<{ sampleN: number; freshestAt: string; currency?: string }>())
        .then((metaRows) => metaRows[0]),
    ]);

    // A newest-first trend slice is reversed back to chronological order for the display axis (the
    // fetched array is freshly built by json(), so the in-place reverse is safe).
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

  // Memoized on the instance: the first call runs the query, later callers reuse the same promise. The
  // analytics instance is a module-level singleton (trigger/chat.ts), so this cache lives for the PROCESS
  // (the warm Trigger isolate serves many conversations), NOT a single run - it is computed once per
  // isolate lifetime, never per turn. Accepted staleness: after a re-ingest a warm isolate
  // serves the prior corpus's DATA SCOPE note until it recycles; harmless for the static demo corpus, and
  // the note is advisory (it only shapes scope-qualification prose, never a query). A REJECTED promise is
  // NOT cached (see coverageProfile below): one transient ClickHouse error must not poison the memo for the
  // whole isolate life and silently drop the scope note on every later turn.
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

  // The scored selection: run the rows query and the per-company match-count meta concurrently (max-
  // not sum-latency), then map the raw rows to ScoredPostingRow and reduce the meta groups to the
  // total + dominant company + freshestAt. A NULL/empty city maps to null ("not listed"), the remote
  // UInt8 to a boolean. A 0-match query returns rows=[] and total=0 (the card's honest no-match state).
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

  return {
    runQuery: (name, params) => executeBuilt(buildTemplateSql(name, params, table)),
    runComposedQuery: (params) => executeBuilt(buildComposedSql(params, table)),
    searchPostings,
    // Cache only a FULFILLED result: on rejection, clear the memo so the next call retries (never a
    // permanently-poisoned rejected promise).
    coverageProfile: () =>
      (coverageCache ??= computeCoverage().catch((err) => {
        coverageCache = undefined;
        throw err;
      })),
  };
}
