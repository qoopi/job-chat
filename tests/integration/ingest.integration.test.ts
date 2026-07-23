import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { applyClickhouseMigrations, createWriterClient } from "@shared/clickhouse";
import { createClickhouseRowSink, ingestPostings, type RowSink } from "@shared/ingest";
import { page, pageOf, posting, scriptedClient } from "../fixtures/ingest.fixture";

// Integration: real ClickHouse. Skipped when creds are absent (e.g. CI without secrets).
const hasCreds = Boolean(process.env.CLICKHOUSE_URL);

const ingestedAt = new Date("2026-07-18T06:00:00Z");

describe.skipIf(!hasCreds)("ingestPostings against real ClickHouse", () => {
  let ch: ClickHouseClient;
  let sink: RowSink;
  const tables: string[] = [];

  async function tempTable(suffix: string): Promise<string> {
    const name = `postings_it_${Date.now()}_${suffix}`;
    // Copies structure + engine (ReplacingMergeTree) + ORDER BY from the migrated table.
    await ch.command({ query: `CREATE TABLE ${name} AS postings`, clickhouse_settings: { wait_end_of_query: 1 } });
    tables.push(name);
    return name;
  }

  async function count(table: string, mode: "" | "FINAL" = ""): Promise<number> {
    const rs = await ch.query({ query: `SELECT count() AS c FROM ${table} ${mode}`, format: "JSONEachRow" });
    return Number((await rs.json<{ c: string }>())[0].c);
  }

  beforeAll(async () => {
    ch = createWriterClient();
    sink = createClickhouseRowSink(ch);
    await applyClickhouseMigrations(ch); // ensure base `postings` exists
  });

  afterAll(async () => {
    for (const t of tables) {
      await ch.command({ query: `DROP TABLE IF EXISTS ${t}`, clickhouse_settings: { wait_end_of_query: 1 } });
    }
    await ch.close();
  });

  it("upserts without duplicates when the ingest runs twice (AC-1)", async () => {
    const table = await tempTable("ac1");
    const client = scriptedClient([page([1, 2], 1, 2, 3), page([3], 2, 2, 3)]);

    const first = await ingestPostings({ client, sink, ingestedAt, table });
    expect(first).toEqual({ pages: 2, rows: 3, totalCount: 3 });
    expect(await count(table, "FINAL")).toBe(3);

    // Re-run: same 3 keys, but a LATER ingestedAt and changed content (title). Proves
    // ReplacingMergeTree(ingested_at) actually keeps the freshest version, not merely
    // that duplicates collapse (which identical reinserts would pass on luck alone).
    const laterIngestedAt = new Date("2026-07-19T06:00:00Z");
    const rerunClient = scriptedClient([
      pageOf([posting(1, "Job 1 UPDATED"), posting(2)], 1, 2, 3),
      page([3], 2, 2, 3),
    ]);
    await ingestPostings({ client: rerunClient, sink, ingestedAt: laterIngestedAt, table });
    expect(await count(table, "FINAL")).toBe(3);

    const rs = await ch.query({
      query: `SELECT external_id, title FROM ${table} FINAL ORDER BY external_id`,
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ external_id: string; title: string }>();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2", "3"]);
    // The freshest ingest's content wins on the duplicate key, not the first insert's.
    expect(rows[0].title).toBe("Job 1 UPDATED");
  });

  it("keeps existing data and fails when a pull errors mid-batch (AC-2)", async () => {
    const table = await tempTable("ac2");
    const client = scriptedClient([page([1, 2], 1, 3, 6), new Error("jobs-api 503 on page 2")]);

    await expect(ingestPostings({ client, sink, ingestedAt, table })).rejects.toThrow(/page 2/);

    // Page 1's rows landed before the failure and remain queryable.
    expect(await count(table, "FINAL")).toBe(2);
  });
});
