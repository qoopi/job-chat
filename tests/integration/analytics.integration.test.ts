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
    // A spy that records exactly the query text sent to ClickHouse.
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

  // Security: chStr() is the only thing standing between a free-text param and a raw-interpolated
  // ClickHouse string literal (the deliberate deviation from query_params - see the module header).
  // Unit tests check the escaped text; this proves it holds
  // against ClickHouse's REAL parser, not just a string match - each payload must stay inert (no
  // rows match, since none of the fixture companies are garbage) and must not error out (a broken
  // escaper produces invalid SQL, which ClickHouse rejects).
  it("keeps injection-style free-text params inert against the real ClickHouse parser (no break-out)", async () => {
    const payloads = [
      "O'Brien", // single quote
      "back\\slash", // literal backslash
      "x' OR '1'='1", // classic quote break-out / filter-bypass attempt
      "line1\nline2", // embedded newline
      `'; DROP TABLE ${TABLE}; --`, // statement-injection attempt (targets the disposable test table)
    ];
    for (const company of payloads) {
      const res = await analytics.runQuery("latest_postings", { company });
      // None of the fixture companies (Google/Meta/Stripe/Amazon) match any payload above - a
      // non-empty result would mean the filter stopped being "company ILIKE '%<payload>%'" and
      // became something else (a break-out).
      expect(res.rows).toEqual([]);
    }
    // The disposable fixture table must still be intact - a successful DROP-TABLE break-out would
    // have destroyed it (and every later assertion/afterAll in this suite would then fail too).
    const stillThere = await writer.query({
      query: `SELECT count() AS c FROM ${TABLE}`,
      format: "JSONEachRow",
    });
    const [{ c }] = await stillThere.json<{ c: number }>();
    expect(Number(c)).toBe(10);
  });

  // `company`/`role` are wrapped as `%...%` before escaping, so a trailing backslash there always
  // has a literal `%` between it and the closing quote chStr appends - never the adjacency the
  // classic "backslash eats the closing quote" break-out needs. `city` is escaped bare
  // (`city = ${chStr(p.city)}`), so a trailing backslash sits immediately before that quote: the one
  // position where an unescaped backslash would swallow it and desynchronize the rest of the query.
  // Proven against the real parser, same as above - not just the generated SQL text.
  it("keeps a trailing backslash inert where it sits directly against the closing quote (city)", async () => {
    const res = await analytics.runQuery("salary_distribution", { city: "trail\\" });
    expect(res.rows).toEqual([]); // no fixture city is garbage, so a real filter matches nothing
  });

  // coverageProfile runs against real ClickHouse over the seeded fixture (10 rows, one
// snapshot). Google leads (4 of 10); 8 of 10 carry a salary range; 4 distinct companies.
  it("coverageProfile returns the corpus shape from the seeded fixture (AC / 018 strand 5)", async () => {
    const profile = await analytics.coverageProfile();
    expect(profile.total).toBe(10);
    expect(profile.distinctCompanies).toBe(4);
    expect(profile.topCompany).toBe("Google");
    expect(profile.topCompanyShare).toBeCloseTo(0.4, 5);
    expect(profile.salaryCoverage).toBeCloseTo(0.8, 5);
    expect(profile.freshestAt).toBe(FIXTURE_INGESTED_AT);
  });

  // The dominant-currency GROUP BY / ORDER BY count() DESC selection must execute against genuinely
  // mixed currencies on real ClickHouse (the shared fixture is all-USD; string-shape unit tests use a
  // mocked client). Seeds its own table (3 USD rows, 1 EUR row) and proves the salary aggregate
  // filters to USD only and meta.currency surfaces it.
  it("filters a salary aggregate to the dominant currency on a real mixed-currency dataset", async () => {
    const MIXED_TABLE = "postings_test_currency";
    const base = {
      source: "fixture",
      region: "California",
      country: "United States",
      location_kind: "onsite" as const,
      employment_type: "full-time",
      experience_level: "Senior",
      published_at: "2026-07-18 10:00:00",
      ingested_at: FIXTURE_INGESTED_AT,
    };
    await loadFixtureTable(writer, MIXED_TABLE); // gets the DDL, then we replace the seeded rows below
    await writer.command({ query: `TRUNCATE TABLE ${MIXED_TABLE}`, clickhouse_settings: { wait_end_of_query: 1 } });
    await writer.insert({
      table: MIXED_TABLE,
      values: [
        { ...base, external_id: "c1", title: "Engineer", company: "Google", city: "San Francisco", salary_min: 150000, salary_max: 190000, salary_currency: "USD" },
        { ...base, external_id: "c2", title: "Engineer", company: "Meta", city: "San Francisco", salary_min: 140000, salary_max: 160000, salary_currency: "USD" },
        { ...base, external_id: "c3", title: "Engineer", company: "Amazon", city: "San Francisco", salary_min: 130000, salary_max: 170000, salary_currency: "USD" },
        { ...base, external_id: "c4", title: "Engineer", company: "Spotify", city: "Berlin", salary_min: 90000, salary_max: 110000, salary_currency: "EUR" },
      ],
      format: "JSONEachRow",
    });

    const mixedAnalytics = createAnalytics({ client: writer, table: MIXED_TABLE });
    const res = await mixedAnalytics.runQuery("salary_distribution", {});
    expect(res.meta.currency).toBe("USD"); // 3 USD vs 1 EUR - USD is dominant
    expect(res.meta.sampleN).toBe(3); // the EUR row is excluded from the salaried set
    const totalRows = res.rows.reduce((sum, r) => sum + Number(r.count), 0);
    expect(totalRows).toBe(3);

    await writer.command({ query: `DROP TABLE IF EXISTS ${MIXED_TABLE}`, clickhouse_settings: { wait_end_of_query: 1 } });
  });

  for (const q of LAUNCH_QUESTIONS) {
    it(`${q.id}: runs ${q.tool}, returns the executed SQL, and matches the fixture (AC-6, AC-11)`, async () => {
      executed.length = 0;
      const res = await analytics.runQuery(q.tool as TemplateName, q.params);

      // meta.sql (result.sql) equals the statement ClickHouse actually received.
      expect(executed[0]).toBe(res.sql);
      expect(res.sql).toContain(`FROM ${TABLE} FINAL`);

      // rows match the hand-computed fixture expectations.
      expect(res.rows).toEqual(EXPECTED_ROWS[q.id]);
      expect(res.meta.sampleN).toBe(EXPECTED_SAMPLE_N[q.id]);
      expect(res.meta.freshestAt).toBe(FIXTURE_INGESTED_AT);

      // The launch case table's expected verdict matches the live query output.
      const h = headline(q.tool, res.rows);
      expect(h.verdict).toBe(q.expectedVerdict);
      if (q.expectedLabel !== undefined) expect(h.label).toBe(q.expectedLabel);
    });
  }
});
