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

function whereClause(filters: string[]): string {
  return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
}

function assemble(lines: string[]): string {
  return lines.filter((line) => line !== "").join("\n");
}

function roleFilter(role: string): string {
  return `title ILIKE ${chStr(`%${role}%`)}`;
}

function trendWindow(table: string, days: number): string {
  return `published_at > (SELECT max(published_at) FROM ${table} FINAL) - INTERVAL ${days} DAY`;
}

const SalaryDistributionParams = z
  .object({ role: z.string().min(1).optional(), city: z.string().min(1).optional() })
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
      return { sql, where };
    }
    case "salary_compare": {
      const p = SalaryCompareParams.parse(rawParams);
      const filters = [
        "salary_min IS NOT NULL",
        "salary_max IS NOT NULL",
        `city IN (${p.cities.map((c) => chStr(c)).join(", ")})`,
      ];
      if (p.role) filters.push(roleFilter(p.role));
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
      return { sql, where };
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
      return { sql, where };
    }
    case "top_companies": {
      const p = TopCompaniesParams.parse(rawParams);
      const filters: string[] = [];
      if (p.days !== undefined) filters.push(trendWindow(table, p.days));
      if (p.city) filters.push(`city = ${chStr(p.city)}`);
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
      return { sql, where };
    }
    case "share_split": {
      const p = ShareSplitParams.parse(rawParams);
      const dimColumn = p.dimension === "experience" ? "experience_level" : "location_kind";
      const filters: string[] = [];
      if (p.role) filters.push(roleFilter(p.role));
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
      return { sql, where };
    }
    case "latest_postings": {
      const p = LatestPostingsParams.parse(rawParams);
      const filters: string[] = [];
      if (p.company) filters.push(`company ILIKE ${chStr(`%${p.company}%`)}`);
      if (p.level) filters.push(`experience_level = ${chStr(p.level)}`);
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
      return { sql, where };
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown analytics template: ${String(exhaustive)}`);
    }
  }
}

export interface QueryResult {
  sql: string;
  rows: Record<string, unknown>[];
  meta: { sampleN: number; freshestAt: string };
}

export interface Analytics {
  runQuery(name: TemplateName, params: unknown): Promise<QueryResult>;
}

/**
 * Build the analytics catalog over a ClickHouse client. In production the client is the read-only
 * `jobchat_ro` user (createReadOnlyClient) reading `postings`; tests inject a writer client and a
 * `postings_test` table so expected numbers are stable regardless of live ingest.
 */
export function createAnalytics(config: { client: ClickHouseClient; table?: string }): Analytics {
  const table = config.table ?? "postings";
  const { client } = config;

  return {
    async runQuery(name, params) {
      const { sql, where } = buildTemplateSql(name, params, table);
      const rowsRs = await client.query({
        query: sql,
        format: "JSONEachRow",
        clickhouse_settings: QUERY_SETTINGS,
      });
      const rows = await rowsRs.json<Record<string, unknown>>();

      const metaSql = assemble([
        "SELECT",
        "  count() AS sampleN,",
        "  max(ingested_at) AS freshestAt",
        `FROM ${table} FINAL`,
        where,
      ]);
      const metaRs = await client.query({
        query: metaSql,
        format: "JSONEachRow",
        clickhouse_settings: QUERY_SETTINGS,
      });
      const metaRow = (await metaRs.json<{ sampleN: number; freshestAt: string }>())[0];

      return {
        sql,
        rows,
        meta: { sampleN: Number(metaRow.sampleN), freshestAt: String(metaRow.freshestAt) },
      };
    },
  };
}
