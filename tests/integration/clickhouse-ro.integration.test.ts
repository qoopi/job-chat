import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { createReadOnlyClient } from "@shared/clickhouse";
import type { PostingRow } from "@shared/postings";

// Integration: the dedicated read-only analytics user jobchat_ro (SELECT on postings only). Skipped
// when the RO creds are absent.
const hasCreds = Boolean(process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_RO_USER);

const sampleRow: PostingRow = {
  source: "ro-test",
  external_id: "ro-test",
  title: "x",
  company: "x",
  city: null,
  region: null,
  country: null,
  location_kind: "onsite",
  employment_type: "",
  experience_level: "",
  salary_min: null,
  salary_max: null,
  salary_currency: null,
  published_at: "2026-07-18 00:00:00",
  apply_url: "",
  role_names: [],
  description_text: "",
  description_html: "",
  department: "",
  ingested_at: "2026-07-18 00:00:00",
};

describe.skipIf(!hasCreds)("jobchat_ro read-only user", () => {
  let ro: ClickHouseClient;

  beforeAll(() => {
    ro = createReadOnlyClient();
  });

  afterAll(async () => {
    await ro.close();
  });

  it("can SELECT from postings (the one granted table)", async () => {
    const rs = await ro.query({
      query: "SELECT count() AS c FROM default.postings",
      format: "JSONEachRow",
    });
    const [{ c }] = await rs.json<{ c: string }>();
    expect(Number(c)).toBeGreaterThanOrEqual(0);
  });

  it("is denied a non-granted table (scope is postings only)", async () => {
    await expect(
      ro
        .query({ query: "SELECT count() FROM default.public_users", format: "JSONEachRow" })
        .then((r) => r.json()),
    ).rejects.toThrow();
  });

  it("is denied writes to postings (read-only)", async () => {
    await expect(
      ro.insert({ table: "default.postings", values: [sampleRow], format: "JSONEachRow" }),
    ).rejects.toThrow();
  });
});
