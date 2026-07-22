import { describe, expect, it } from "vitest";
import { ingestPostings } from "@shared/ingest";
import { collectingSink, page, scriptedClient } from "../fixtures/ingest.fixture";

const ingestedAt = new Date("2026-07-18T06:00:00Z");

describe("ingestPostings", () => {
  it("pages the API and inserts one batch per page", async () => {
    const { sink, batches } = collectingSink();
    const client = scriptedClient([
      page([1, 2], 1, 2, 3),
      page([3], 2, 2, 3),
    ]);

    const result = await ingestPostings({ client, sink, ingestedAt });

    expect(result).toEqual({ pages: 2, rows: 3, totalCount: 3 });
    expect(batches).toHaveLength(2);
    expect(batches[0].map((r) => r.external_id)).toEqual(["1", "2"]);
    expect(batches[1].map((r) => r.external_id)).toEqual(["3"]);
    expect(batches[0][0].ingested_at).toBe("2026-07-18 06:00:00");
  });

  it("leaves already-inserted batches intact and fails when a later page errors (AC-2)", async () => {
    const { sink, batches } = collectingSink();
    const client = scriptedClient([
      page([1, 2], 1, 3, 6),
      new Error("jobs-api 503 on page 2"),
    ]);

    await expect(ingestPostings({ client, sink, ingestedAt })).rejects.toThrow(/page 2/);

    // Page 1's rows were already inserted before the failure - prior data intact.
    expect(batches).toHaveLength(1);
    expect(batches[0].map((r) => r.external_id)).toEqual(["1", "2"]);
  });
});
