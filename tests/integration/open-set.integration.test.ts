import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import type { PostingRow } from "@shared/postings";
import { createWriterClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";

// Two ingest snapshots stamped with different `ingested_at`, seeded into a private
// table. A current-state read (open-set predicate) counts ONLY the latest snapshot; a trend read keeps
// the full history. Distinct external_ids per snapshot, so FINAL keeps all rows and the predicate - not
// dedup - is what excludes the stale snapshot. Skipped without creds.
const hasCreds = Boolean(process.env.CLICKHOUSE_URL);
const TABLE = "postings_openset_test";

const STALE_AT = "2026-07-10 06:00:00";
const FRESH_AT = "2026-07-18 06:00:00";

function row(overrides: Partial<PostingRow> & Pick<PostingRow, "external_id" | "company" | "ingested_at">): PostingRow {
  return {
    source: "fixture",
    title: "Engineer",
    city: "San Francisco",
    region: "California",
    country: "United States",
    location_kind: "onsite",
    employment_type: "full-time",
    experience_level: "Senior",
    salary_min: 150000,
    salary_max: 190000,
    salary_currency: "USD",
    published_at: "2026-07-17 09:00:00",
    apply_url: "",
    role_names: [],
    description_text: "",
    description_html: "",
    department: "",
    ...overrides,
  };
}

// 3 stale rows (a superseded snapshot) + 5 fresh rows (the current open set) = 8 total in history.
const STALE_ROWS: PostingRow[] = [
  row({ external_id: "s1", company: "OldCorp", ingested_at: STALE_AT }),
  row({ external_id: "s2", company: "OldCorp", ingested_at: STALE_AT }),
  row({ external_id: "s3", company: "OldCorp", ingested_at: STALE_AT }),
];
const FRESH_ROWS: PostingRow[] = [
  row({ external_id: "f1", company: "Google", ingested_at: FRESH_AT }),
  row({ external_id: "f2", company: "Google", ingested_at: FRESH_AT }),
  row({ external_id: "f3", company: "Google", ingested_at: FRESH_AT }),
  row({ external_id: "f4", company: "Meta", ingested_at: FRESH_AT }),
  row({ external_id: "f5", company: "Meta", ingested_at: FRESH_AT }),
];

describe.skipIf(!hasCreds)("open-set predicate against a two-snapshot table", () => {
  let writer: ClickHouseClient;
  let analytics: Analytics;

  beforeAll(async () => {
    writer = createWriterClient();
    await writer.command({
      query: `DROP TABLE IF EXISTS ${TABLE}`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    await writer.command({
      query: `CREATE TABLE ${TABLE} AS postings`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    await writer.insert({ table: TABLE, values: [...STALE_ROWS, ...FRESH_ROWS], format: "JSONEachRow" });
    analytics = createAnalytics({ client: writer, table: TABLE });
  });

  afterAll(async () => {
    await writer.command({
      query: `DROP TABLE IF EXISTS ${TABLE}`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    await writer.close();
  });

  it("counts only the latest snapshot for a current-state composed query (and flags openSet)", async () => {
    const res = await analytics.runComposedQuery({ measures: ["count"] });
    expect(res.sql).toContain(`ingested_at = (SELECT max(ingested_at) FROM ${TABLE})`);
    expect(Number(res.rows[0].count)).toBe(FRESH_ROWS.length); // 5, the stale snapshot excluded
    expect(res.meta.sampleN).toBe(FRESH_ROWS.length);
    expect(res.meta.openSet).toBe(true);
  });

  it("excludes the stale snapshot from a current-state template (top_companies)", async () => {
    const res = await analytics.runQuery("top_companies", {});
    const companies = res.rows.map((r) => r.company);
    expect(companies).not.toContain("OldCorp");
    expect(res.rows.find((r) => r.company === "Google")).toEqual({ company: "Google", count: 3 });
    expect(res.meta.sampleN).toBe(FRESH_ROWS.length);
    expect(res.meta.openSet).toBe(true);
  });

  it("keeps the full history for a trend read (stale snapshot included, no openSet flag)", async () => {
    const res = await analytics.runQuery("postings_trend", { days: 3650 });
    const total = res.rows.reduce((sum, r) => sum + Number(r.count), 0);
    expect(total).toBe(STALE_ROWS.length + FRESH_ROWS.length); // 8, full history
    expect(res.sql).not.toContain("ingested_at =");
    expect(res.meta.openSet).toBeUndefined();
  });
});
