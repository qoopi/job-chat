import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { createWriterClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";
import type { PostingRow } from "@shared/postings";
import { loadFixtureTable } from "../fixtures/load";

// Integration: getPostingDetail reads ONE posting by (source, external_id) against real ClickHouse. Proves
// the by-key lookup, the not-found -> null guard, and the forward-compat empty-description case. Skipped
// without creds.
const hasCreds = Boolean(process.env.CLICKHOUSE_URL);
const TABLE = "postings_detail_test";
const INGESTED = "2026-07-18 06:00:00";

function row(over: Partial<PostingRow> & Pick<PostingRow, "external_id" | "title" | "company">): PostingRow {
  return {
    source: "detailfix",
    city: null,
    region: null,
    country: null,
    location_kind: "onsite",
    employment_type: "full-time",
    experience_level: "Senior",
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    published_at: "2026-07-10 10:00:00",
    apply_url: "",
    role_names: [],
    description_text: "",
    department: "",
    ingested_at: INGESTED,
    ...over,
  };
}

const ROWS: PostingRow[] = [
  row({
    external_id: "D1",
    title: "Senior Backend Engineer",
    company: "Google",
    city: "Berlin",
    region: "Berlin",
    country: "Germany",
    location_kind: "remote",
    salary_min: 160000,
    salary_max: 200000,
    salary_currency: "USD",
    apply_url: "https://careers.google.com/jobs/results/D1",
    department: "Cloud",
    description_text: "About the role\nOwn the ingest pipeline.",
  }),
  // Forward-compat: a pre-reingest row - empty description_text + department must read back as a valid detail.
  row({ external_id: "D2", title: "Recruiter", company: "Stripe" }),
];

describe.skipIf(!hasCreds)("getPostingDetail reads one posting by natural key", () => {
  let writer: ClickHouseClient;
  let analytics: Analytics;

  beforeAll(async () => {
    writer = createWriterClient();
    await loadFixtureTable(writer, TABLE); // gets the postings DDL, then we replace the rows
    await writer.command({ query: `TRUNCATE TABLE ${TABLE}`, clickhouse_settings: { wait_end_of_query: 1 } });
    await writer.insert({ table: TABLE, values: ROWS, format: "JSONEachRow" });
    analytics = createAnalytics({ client: writer, table: TABLE });
  });

  afterAll(async () => {
    await writer.command({ query: `DROP TABLE IF EXISTS ${TABLE}`, clickhouse_settings: { wait_end_of_query: 1 } });
    await writer.close();
  });

  it("returns the full detail for a known (source, external_id)", async () => {
    const detail = await analytics.getPostingDetail("detailfix", "D1");
    expect(detail).toEqual({
      title: "Senior Backend Engineer",
      company: "Google",
      city: "Berlin",
      region: "Berlin",
      country: "Germany",
      remote: true,
      salaryMin: 160000,
      salaryMax: 200000,
      department: "Cloud",
      descriptionText: "About the role\nOwn the ingest pipeline.",
      applyUrl: "https://careers.google.com/jobs/results/D1",
    });
  });

  it("returns null for an unknown key (not-found guard)", async () => {
    expect(await analytics.getPostingDetail("detailfix", "does-not-exist")).toBeNull();
    // Right external_id, wrong source: the key is the PAIR, so this is still not-found.
    expect(await analytics.getPostingDetail("other-source", "D1")).toBeNull();
  });

  it("forward-compat: a pre-reingest row reads back as a valid empty detail (no crash)", async () => {
    const detail = await analytics.getPostingDetail("detailfix", "D2");
    expect(detail).toMatchObject({
      title: "Recruiter",
      company: "Stripe",
      city: null,
      remote: false,
      salaryMin: null,
      salaryMax: null,
      department: "",
      descriptionText: "",
      applyUrl: "",
    });
  });
});
