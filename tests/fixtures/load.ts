import type { ClickHouseClient } from "@clickhouse/client";
import { FIXTURE_POSTINGS } from "./postings.fixture";

// Load the reference fixture into a separate table (default `postings_test`) with the postings DDL, so
// expected numbers stay stable regardless of live ingest. Used by the analytics and agent tests.
// Requires the base `postings` table to exist (ch:migrate).
export async function loadFixtureTable(
  client: ClickHouseClient,
  table = "postings_test",
): Promise<void> {
  await client.command({
    query: `DROP TABLE IF EXISTS ${table}`,
    clickhouse_settings: { wait_end_of_query: 1 },
  });
  await client.command({
    query: `CREATE TABLE ${table} AS postings`,
    clickhouse_settings: { wait_end_of_query: 1 },
  });
  await client.insert({ table, values: FIXTURE_POSTINGS, format: "JSONEachRow" });
}
