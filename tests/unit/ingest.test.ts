import { describe, expect, it } from "vitest";
import { ingestPostings, type RowSink } from "@shared/ingest";
import type { PostingRow } from "@shared/postings";
import type { PostingsPage } from "@shared/searchnapply";
import type { SearchnapplyClient } from "@shared/searchnapply";

const ingestedAt = new Date("2026-07-18T06:00:00Z");

function posting(id: number) {
  return {
    id,
    title: `Job ${id}`,
    company: "Google",
    source: "GoogleCareers",
    employmentType: "full-time",
    experienceLevel: "Senior",
    salary: null,
    locations: [{ city: "Tokyo", region: "Tokyo", country: "Japan", kind: 0 }],
    publishedAt: "2026-07-17T23:38:42Z",
  };
}

function page(items: number[], pageNo: number, totalPages: number, totalCount: number): PostingsPage {
  return {
    items: items.map(posting),
    page: pageNo,
    pageSize: 100,
    totalCount,
    totalPages,
  };
}

function collectingSink() {
  const batches: PostingRow[][] = [];
  const sink: RowSink = {
    async insert({ values }) {
      batches.push(values);
    },
  };
  return { sink, batches };
}

// A client that yields the given pages in order, optionally throwing on a page.
function scriptedClient(pages: (PostingsPage | Error)[]): SearchnapplyClient {
  return {
    login: async () => "tok",
    fetchPostingsPage: async (p) => {
      const entry = pages[p - 1];
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

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
