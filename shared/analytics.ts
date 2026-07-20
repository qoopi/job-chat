import { z } from "zod";
import type { ClickHouseClient } from "@clickhouse/client";

// The analytics catalog: the ONLY path from the agent to ClickHouse. Six parameterized SQL templates
// (one per launch-question shape), each validated with Zod, read dedup-correct via FINAL, and bounded
// by a row LIMIT + max_execution_time. runQuery returns { sql, rows, meta } where `sql` is the exact
// statement executed - "Show query" reveals it verbatim (honesty = rubric depth, feasibility must-fix
// 4). See the query-catalog key decision in the epic technical design.
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
 * The open-set predicate (AC-3): keep only rows from the latest ingest snapshot. Sound because every
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

// Exported so task 004 wires the agent's tool input schemas from the one home (DRY).
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
      return { sql, where, openSet: true };
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
      return { sql, where, openSet: true };
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
        "ORDER BY day",
        `LIMIT ${LIMITS.postings_trend}`,
      ]);
      // Trend keeps full history (closed postings are legitimate history) - no open-set predicate.
      return { sql, where, openSet: false };
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
// query_postings' data layer (AC-1/AC-2): a whitelisted aggregate over the postings schema. Same
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
 * The query_postings input schema, exported like TEMPLATE_PARAM_SCHEMAS so 009 wires the tool input
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

  const filters: string[] = [];
  if (p.measures.some((m) => SALARY_MEASURES.has(m))) {
    filters.push("salary_min IS NOT NULL", "salary_max IS NOT NULL");
  }
  if (p.role) filters.push(roleFilter(p.role));
  if (p.company) filters.push(`company ILIKE ${chStr(`%${likeEscape(p.company)}%`)}`);
  if (p.city) filters.push(`city = ${chStr(p.city)}`);
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
  const where = whereClause(filters);

  const sortExpr = p.measures.includes(sort.by as ComposedMeasure)
    ? sort.by
    : dims.find((d) => d.alias === sort.by)!.group;
  const orderParts = [`${sortExpr} ${sort.dir.toUpperCase()}`];
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
  return { sql, where, openSet };
}

export interface QueryResult {
  sql: string;
  rows: Record<string, unknown>[];
  // `openSet` is present (true) only on a current-state read; absent = full history (AC-3). Optional so
  // every persisted P1 payload stays valid and it is never default-injected.
  meta: { sampleN: number; freshestAt: string; openSet?: boolean };
}

export interface Analytics {
  runQuery(name: TemplateName, params: unknown): Promise<QueryResult>;
  // The execution seam for query_postings (009's tool calls this). Tools receive Analytics, never a raw
  // client, so the composed path must live on the interface too.
  runComposedQuery(params: unknown): Promise<QueryResult>;
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
    const metaSql = assemble([
      "SELECT",
      "  count() AS sampleN,",
      "  max(ingested_at) AS freshestAt",
      `FROM ${table} FINAL`,
      built.where,
    ]);

    // The rows and meta reads are independent (neither consumes the other's result), so fire them
    // concurrently - on the per-turn ClickHouse Cloud hot path this is max- not sum-latency.
    // Promise.all attaches a rejection handler to BOTH promises up front, so if one query fails the
    // sibling's rejection is still handled (no unhandled rejection) and the error surface matches the
    // old sequential path: the whole call rejects with whichever query failed first.
    const [rows, metaRow] = await Promise.all([
      client
        .query({ query: built.sql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<Record<string, unknown>>()),
      client
        .query({ query: metaSql, format: "JSONEachRow", clickhouse_settings: QUERY_SETTINGS })
        .then((rs) => rs.json<{ sampleN: number; freshestAt: string }>())
        .then((metaRows) => metaRows[0]),
    ]);

    return {
      sql: built.sql,
      rows,
      meta: {
        sampleN: Number(metaRow.sampleN),
        freshestAt: String(metaRow.freshestAt),
        ...(built.openSet ? { openSet: true } : {}),
      },
    };
  }

  return {
    runQuery: (name, params) => executeBuilt(buildTemplateSql(name, params, table)),
    runComposedQuery: (params) => executeBuilt(buildComposedSql(params, table)),
  };
}
