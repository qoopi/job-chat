import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

// Validates only the ClickHouse slice (ISP) - ingestion needs no AWS/Bedrock creds; env.ts composes it in.
export const ClickhouseEnvSchema = z.object({
  CLICKHOUSE_URL: z.string().min(1),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().min(1),
});

// ClickHouse Cloud idles the service; its wake exceeds the client's 30s default, so allow 60s per request.
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

// Analytics read path: the dedicated read-only user (SELECT on postings only); validates only its slice (ISP).
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

// Apply migrations/clickhouse/*.sql in filename order; idempotent (IF NOT EXISTS), safe to re-run. Each
// file MUST hold exactly ONE statement - the ClickHouse HTTP interface rejects multi-statement queries.
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
