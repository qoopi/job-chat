import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { createWriterClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics, type TemplateName } from "@shared/analytics";
import { loadFixtureTable } from "../fixtures/load";
import { FIXTURE_INGESTED_AT } from "../fixtures/postings.fixture";
import { LAUNCH_QUESTIONS } from "../fixtures/launch-questions";

// Integration: real ClickHouse, but reads a `postings_test` table seeded from the fixture so the
// expected numbers are stable regardless of live ingest. Skipped without creds.
const hasCreds = Boolean(process.env.CLICKHOUSE_URL);
const TABLE = "postings_test";

// Expected rows worked out by hand from tests/fixtures/postings.fixture.ts (not recomputed the way
// the SQL does). counts come back as numbers (output_format_json_quote_64bit_integers = 0).
const EXPECTED_ROWS: Record<string, Record<string, unknown>[]> = {
  Q1: [
    { bucket: 160000, count: 1, median: 180000 },
    { bucket: 180000, count: 1, median: 180000 },
    { bucket: 200000, count: 1, median: 180000 },
  ],
  Q2: [
    { city: "San Francisco", median: 180000, n: 3 },
    { city: "Los Angeles", median: 140000, n: 3 },
  ],
  Q3: [
    { day: "2026-07-12", count: 1 },
    { day: "2026-07-13", count: 1 },
    { day: "2026-07-14", count: 1 },
    { day: "2026-07-15", count: 1 },
    { day: "2026-07-16", count: 2 },
    { day: "2026-07-17", count: 2 },
    { day: "2026-07-18", count: 2 },
  ],
  Q4: [
    { company: "Google", count: 4 },
    { company: "Amazon", count: 2 },
    { company: "Meta", count: 2 },
    { company: "Stripe", count: 2 },
  ],
  Q5: [
    { label: "Senior", count: 5 },
    { label: "Junior", count: 3 },
    { label: "Staff", count: 2 },
  ],
  Q6: [
    { label: "onsite", count: 4 },
    { label: "hybrid", count: 3 },
    { label: "remote", count: 3 },
  ],
  Q7: [
    { title: "Senior Software Engineer", company: "Google", city: "San Francisco", experience_level: "Senior", salary_min: 150000, salary_max: 190000, salary_currency: "USD", published_at: "2026-07-18 10:00:00" },
    { title: "Data Scientist", company: "Google", city: "San Francisco", experience_level: "Senior", salary_min: 160000, salary_max: 180000, salary_currency: "USD", published_at: "2026-07-18 08:00:00" },
    { title: "Senior Engineer", company: "Google", city: "Los Angeles", experience_level: "Senior", salary_min: 140000, salary_max: 160000, salary_currency: "USD", published_at: "2026-07-14 09:00:00" },
  ],
};
const EXPECTED_SAMPLE_N: Record<string, number> = { Q1: 3, Q2: 6, Q3: 10, Q4: 10, Q5: 10, Q6: 10, Q7: 3 };

// Derive the headline verdict number/label the way the agent will, to prove the launch case table.
function headline(tool: string, rows: Record<string, unknown>[]): { verdict: number; label?: string } {
  switch (tool) {
    case "salary_distribution":
      return { verdict: Number(rows[0].median) };
    case "salary_compare":
      return { verdict: Number(rows[0].median), label: String(rows[0].city) };
    case "postings_trend":
      return { verdict: rows.reduce((sum, r) => sum + Number(r.count), 0) };
    case "top_companies":
      return { verdict: Number(rows[0].count), label: String(rows[0].company) };
    case "share_split":
      return { verdict: Number(rows[0].count), label: String(rows[0].label) };
    case "latest_postings":
      return { verdict: rows.length, label: String(rows[0].title) };
    default:
      throw new Error(`no headline for ${tool}`);
  }
}

describe.skipIf(!hasCreds)("analytics catalog against seeded ClickHouse", () => {
  let writer: ClickHouseClient;
  let analytics: Analytics;
  const executed: string[] = [];

  beforeAll(async () => {
    writer = createWriterClient();
    await loadFixtureTable(writer, TABLE);
    // A spy that records exactly the query text sent to ClickHouse (the AC-6 "client hook").
    const spy = {
      query: (params: Parameters<ClickHouseClient["query"]>[0]) => {
        executed.push(params.query);
        return writer.query(params);
      },
    } as unknown as ClickHouseClient;
    analytics = createAnalytics({ client: spy, table: TABLE });
  });

  afterAll(async () => {
    await writer.command({
      query: `DROP TABLE IF EXISTS ${TABLE}`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    await writer.close();
  });

  for (const q of LAUNCH_QUESTIONS) {
    it(`${q.id}: runs ${q.tool}, returns the executed SQL, and matches the fixture (AC-6, AC-11)`, async () => {
      executed.length = 0;
      const res = await analytics.runQuery(q.tool as TemplateName, q.params);

      // AC-6: meta.sql (result.sql) equals the statement ClickHouse actually received.
      expect(executed[0]).toBe(res.sql);
      expect(res.sql).toContain(`FROM ${TABLE} FINAL`);

      // rows match the hand-computed fixture expectations.
      expect(res.rows).toEqual(EXPECTED_ROWS[q.id]);
      expect(res.meta.sampleN).toBe(EXPECTED_SAMPLE_N[q.id]);
      expect(res.meta.freshestAt).toBe(FIXTURE_INGESTED_AT);

      // AC-11: the launch case table's expected verdict matches the live query output.
      const h = headline(q.tool, res.rows);
      expect(h.verdict).toBe(q.expectedVerdict);
      if (q.expectedLabel !== undefined) expect(h.label).toBe(q.expectedLabel);
    });
  }
});
