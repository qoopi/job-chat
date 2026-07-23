import { type RowSink } from "@shared/ingest";
import type { PostingRow } from "@shared/postings";
import type { PostingsPage, SearchnapplyClient } from "@shared/searchnapply";

// Shared ingest test factories (unit + integration): a scripted API client, posting/page builders, and a
// collecting sink. Kept behavior-identical to the inline copies they replaced.

export function posting(id: number, title = `Job ${id}`) {
  return {
    id,
    title,
    company: "Google",
    source: "GoogleCareers",
    employmentType: "full-time",
    experienceLevel: "Senior",
    salary: null,
    locations: [{ city: "Tokyo", region: "Tokyo", country: "Japan", kind: 0 }],
    publishedAt: "2026-07-17T23:38:42Z",
  };
}

export function page(ids: number[], pageNo: number, totalPages: number, totalCount: number): PostingsPage {
  return { items: ids.map((id) => posting(id)), page: pageNo, pageSize: 100, totalCount, totalPages };
}

/** Like `page`, but for pre-built posting items (to vary content between two runs). */
export function pageOf(
  items: ReturnType<typeof posting>[],
  pageNo: number,
  totalPages: number,
  totalCount: number,
): PostingsPage {
  return { items, page: pageNo, pageSize: 100, totalCount, totalPages };
}

/** A client that yields the given pages in order, throwing on any page that is an Error. */
export function scriptedClient(pages: (PostingsPage | Error)[]): SearchnapplyClient {
  return {
    login: async () => "tok",
    fetchPostingsPage: async (p) => {
      const entry = pages[p - 1];
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

export function collectingSink() {
  const batches: PostingRow[][] = [];
  const deletes: { table: string; olderThan: Date }[] = [];
  const sink: RowSink = {
    async insert({ values }) {
      batches.push(values);
    },
    async deleteOlderThan(params) {
      deletes.push(params);
    },
  };
  return { sink, batches, deletes };
}
