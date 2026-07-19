import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

// The ingestion path validates only its own ClickHouse slice, not the whole env:
// the full getEnv() also requires AWS_* keys that local dev provides via AWS_PROFILE,
// and ingestion touches neither AWS nor Bedrock (ISP - don't couple to what it can't use).
const ClickhouseEnvSchema = z.object({
  CLICKHOUSE_URL: z.string().min(1),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().min(1),
});

// The ingestion writer path uses the default ClickHouse user. The read-only
// analytics user (jobchat_ro) arrives with task 003; keep this factory writer-only.
export function createWriterClient(
  source: Record<string, string | undefined> = process.env,
): ClickHouseClient {
  const env = ClickhouseEnvSchema.parse(source);
  return createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
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
