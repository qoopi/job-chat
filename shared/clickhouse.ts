import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

// The ingestion path validates only its own ClickHouse slice, not the whole env:
// the full getEnv() also requires AWS_* keys that local dev provides via AWS_PROFILE,
// and ingestion touches neither AWS nor Bedrock (ISP - don't couple to what it can't use).
// Exported so shared/env.ts composes the full env schema from the per-domain slices instead of
// re-declaring the same keys. Additive - the ingestion path
// still parses it the same way below.
export const ClickhouseEnvSchema = z.object({
  CLICKHOUSE_URL: z.string().min(1),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().min(1),
});

// ClickHouse Cloud idles the service and its wake exceeds the client's 30s request_timeout default,
// so the first query after idle must survive the wake - both clients allow 60s per request.
export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 60_000;

// The ingestion writer path uses the default ClickHouse user.
export function createWriterClient(
  source: Record<string, string | undefined> = process.env,
): ClickHouseClient {
  const env = ClickhouseEnvSchema.parse(source);
  return createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS,
  });
}

// The analytics read path uses the dedicated read-only user `jobchat_ro` (SELECT on postings only).
// Validates only its own slice (ISP) - CLICKHOUSE_URL + the RO credentials.
export const ClickhouseRoEnvSchema = z.object({
  CLICKHOUSE_URL: z.string().min(1),
  CLICKHOUSE_RO_USER: z.string().min(1),
  CLICKHOUSE_RO_PASSWORD: z.string().min(1),
});

export function createReadOnlyClient(
  source: Record<string, string | undefined> = process.env,
): ClickHouseClient {
  const env = ClickhouseRoEnvSchema.parse(source);
  return createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_RO_USER,
    password: env.CLICKHOUSE_RO_PASSWORD,
    request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS,
  });
}

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "clickhouse",
);

// Apply every migrations/clickhouse/*.sql in filename order. Statements are
// idempotent (CREATE TABLE IF NOT EXISTS), so this is safe to re-run.
// Each file MUST hold exactly ONE statement: the ClickHouse HTTP interface rejects
// multi-statement queries, and each file is sent as a single client.command({ query }).
export async function applyClickhouseMigrations(
  client: ClickHouseClient,
): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await client.command({
      query: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  }
  return files;
}
