import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { createWriterClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";
import type { PostingRow } from "@shared/postings";
import { loadFixtureTable } from "../fixtures/load";

// AC-7 / AC-8: Should_OrderByScoreFormula_When_KnownFixture. Integration against real ClickHouse over a
// bespoke seeded table so the FIXED score formula's ordering is proven against the real parser, not a
// string match. Rows are hand-crafted so every score is worked out by hand (below) and the resulting
// order is strict; two rows share a score to prove the publishedAt DESC tiebreak. Skipped without creds.
const hasCreds = Boolean(process.env.CLICKHOUSE_URL);
const TABLE = "postings_search_test";
const INGESTED = "2026-07-18 06:00:00";

// Params: titleTerms ["senior","backend","engineer"], experience "senior", cities ["Berlin"],
// remoteOk true, salaryMin 150000. Score = 3*min(titleHits,2) + 2*expMatch + 2*cityMatch +
// 1*(remote) + 1*(salary_max>=150000). Bands: Senior/senior->senior, Staff->lead, Mid->mid,
// internship->junior. Hand-computed scores are in each row's comment.
const PARAMS = {
  titleTerms: ["senior", "backend", "engineer"],
  experience: "senior",
  cities: ["Berlin"],
  remoteOk: true,
  salaryMin: 150000,
};

function row(over: Partial<PostingRow> & Pick<PostingRow, "external_id" | "title" | "company">): PostingRow {
  return {
    source: "fixture",
    city: null,
    region: "Bavaria",
    country: "Germany",
    location_kind: "onsite",
    employment_type: "full-time",
    experience_level: "",
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    published_at: "2026-07-10 10:00:00",
    apply_url: "",
    role_ids: [],
    role_names: [],
    ingested_at: INGESTED,
    ...over,
  };
}

const ROWS: PostingRow[] = [
  // A: title 3 hits (cap 2 -> 6) + senior(2) + Berlin(2) + remote(1) + salary 200k>=150k(1) = 12
  row({ external_id: "A", title: "Senior Backend Engineer", company: "Google", city: "Berlin", location_kind: "remote", experience_level: "Senior", salary_min: 160000, salary_max: 200000, salary_currency: "USD", published_at: "2026-07-18 10:00:00", apply_url: "https://careers.google.com/jobs/results/A" }),
  // B: title 2 hits (6) + Staff->lead != senior(0) + Berlin(2) + remote(1) + salary 210k(1) = 10
  row({ external_id: "B", title: "Backend Engineer", company: "Google", city: "Berlin", location_kind: "remote", experience_level: "Staff", salary_min: 170000, salary_max: 210000, salary_currency: "USD", published_at: "2026-07-17 10:00:00" }),
  // C: title 2 hits (6) + senior(2) + Munich != Berlin(0) + hybrid not remote(0) + salary 180k(1) = 9
  row({ external_id: "C", title: "Senior Engineer", company: "Google", city: "Munich", location_kind: "hybrid", experience_level: "senior", salary_min: 155000, salary_max: 180000, salary_currency: "USD", published_at: "2026-07-16 10:00:00" }),
  // D: title 1 hit (3) + senior(2) + Berlin(2) + onsite(0) + salary 140k < 150k(0) = 7
  row({ external_id: "D", title: "Senior Data Scientist", company: "Meta", city: "Berlin", location_kind: "onsite", experience_level: "Senior", salary_min: 120000, salary_max: 140000, salary_currency: "USD", published_at: "2026-07-15 10:00:00" }),
  // G: title 1 hit (3) + Mid != senior(0) + Berlin(2) + remote(1) + salary null(0) = 6  (newer)
  row({ external_id: "G", title: "Cloud Engineer", company: "Meta", city: "Berlin", location_kind: "remote", experience_level: "Mid", published_at: "2026-07-20 10:00:00" }),
  // E: title 1 hit (3) + internship->junior != senior(0) + Berlin(2) + remote(1) + salary null(0) = 6 (older)
  row({ external_id: "E", title: "Junior Engineer", company: "Stripe", city: "Berlin", location_kind: "remote", experience_level: "internship", published_at: "2026-07-19 10:00:00" }),
  // F: no title/exp/city/remote/salary match -> score 0 -> NOT a match (excluded)
  row({ external_id: "F", title: "Product Manager", company: "Amazon", city: "Paris", location_kind: "onsite", experience_level: "Mid", published_at: "2026-07-14 10:00:00" }),
  // H: NULL city (the default), scores 0 under PARAMS (no title/exp/city/remote/salary match) so it does
  // not disturb the ordering/meta above. Its own test below searches a term it DOES match to prove the
  // null-city `city IN (...)` term yields 0 (not NULL) - so the row is not NULL-dropped by WHERE score > 0.
  row({ external_id: "H", title: "Marketing Manager", company: "Spotify", experience_level: "Mid", published_at: "2026-07-13 10:00:00" }),
];

describe.skipIf(!hasCreds)("searchPostings scores + orders by the fixed formula (AC-7/AC-8)", () => {
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

  it("Should_OrderByScoreFormula_When_KnownFixture: matches ranked by score DESC, then publishedAt DESC", async () => {
    const res = await analytics.searchPostings({ ...PARAMS, limit: 50 });

    // F (score 0) is dropped; the six matches come back in the hand-computed order, G before E on the
    // publishedAt DESC tiebreak (both score 6).
    expect(res.rows.map((r) => r.title)).toEqual([
      "Senior Backend Engineer",
      "Backend Engineer",
      "Senior Engineer",
      "Senior Data Scientist",
      "Cloud Engineer",
      "Junior Engineer",
    ]);
    expect(res.rows.map((r) => r.score)).toEqual([12, 10, 9, 7, 6, 6]);
    expect(res.total).toBe(6); // pre-limit count of matches (the "8 of 23" numerator source)
  });

  it("maps the row fields (remote boolean, null salary -> null, raw experience, city passthrough)", async () => {
    const res = await analytics.searchPostings({ ...PARAMS, limit: 50 });
    const a = res.rows[0];
    expect(a).toMatchObject({ company: "Google", city: "Berlin", remote: true, salaryMin: 160000, salaryMax: 200000, experience: "Senior", applyUrl: "https://careers.google.com/jobs/results/A" });
    // Cloud Engineer (G): remote, null salary reads null (never 0), Berlin; no apply link -> "" (never null).
    const g = res.rows.find((r) => r.title === "Cloud Engineer")!;
    expect(g).toMatchObject({ remote: true, salaryMin: null, salaryMax: null, city: "Berlin", applyUrl: "" });
    // Senior Engineer (C): hybrid -> remote false; Munich passthrough.
    const c = res.rows.find((r) => r.title === "Senior Engineer")!;
    expect(c).toMatchObject({ remote: false, city: "Munich" });
  });

  it("computes meta over the matched set (dominant company, its share, freshness)", async () => {
    const res = await analytics.searchPostings({ ...PARAMS, limit: 50 });
    // Among the 6 matches: Google 3, Meta 2, Stripe 1.
    expect(res.meta.topCompany).toBe("Google");
    expect(res.meta.topShare).toBeCloseTo(0.5, 5);
    expect(res.meta.freshestAt).toBe(INGESTED);
  });

  it("honors the hard cap of 50 via the limit param (carries all matches up to the cap)", async () => {
    const res = await analytics.searchPostings({ ...PARAMS, limit: 3 });
    expect(res.rows).toHaveLength(3); // capped to the top 3 by score
    expect(res.total).toBe(6); // total stays the full pre-limit match count
    expect(res.rows.map((r) => r.score)).toEqual([12, 10, 9]);
  });

  it("keeps a NULL-city posting that matches on other terms: city IN (...) yields 0, not NULL (S3)", async () => {
    // H has city = NULL and matches only the title term. With a `cities` filter present the score carries
    // the real `(city IN ('Amsterdam'))` term; under transform_null_in = 1 a NULL city evaluates that to 0
    // (the CH DEFAULT of 0 would make it NULL), so the score stays 3 and the row SURVIVES WHERE score > 0.
    // Were IN(NULL) -> NULL, the whole score would go NULL and H would silently vanish - the regression
    // this pins (and why QUERY_SETTINGS pins transform_null_in = 1).
    const res = await analytics.searchPostings({
      titleTerms: ["Marketing"],
      cities: ["Amsterdam"],
      limit: 50,
    });
    const h = res.rows.find((r) => r.title === "Marketing Manager");
    expect(h).toBeDefined();
    expect(h!.city).toBeNull(); // not listed
    expect(h!.score).toBe(3); // 3 * title hit; the null-city IN term contributed 0, so no NULL-collapse
  });

  it("returns an honest empty result when nothing matches (no invented postings)", async () => {
    const res = await analytics.searchPostings({ titleTerms: ["nonexistent-role-xyz"], limit: 50 });
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.meta.topCompany).toBe("");
    expect(res.meta.topShare).toBe(0);
  });
});
