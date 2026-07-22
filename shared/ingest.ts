import { mapPostingToRow, type PostingRow } from "./postings";
import type { SearchnapplyClient } from "./searchnapply";

// The insert seam: structurally satisfied by @clickhouse/client's insert (real client in prod, fake in tests).
export interface RowSink {
  insert(params: {
    table: string;
    values: PostingRow[];
    format: "JSONEachRow";
  }): Promise<unknown>;
}

export interface IngestDeps {
  client: Pick<SearchnapplyClient, "fetchPostingsPage">;
  sink: RowSink;
  ingestedAt: Date; // task run timestamp; the ReplacingMergeTree version for this run
  table?: string; // default "postings"
  pageSize?: number; // default 100 (jobs-api hard-caps pageSize at 100)
}

export interface IngestResult {
  pages: number;
  rows: number;
  totalCount: number;
}

/** Page the jobs-api, insert one JSONEachRow batch per page. Idempotent: ReplacingMergeTree keyed
 *  (source, external_id) collapses re-pulls; a mid-run failure propagates (Trigger retries), batches intact. */
export async function ingestPostings(deps: IngestDeps): Promise<IngestResult> {
  const table = deps.table ?? "postings";
  const pageSize = deps.pageSize ?? 100;

  let page = 1;
  let rows = 0;
  let totalCount = 0;
  let totalPages = 1;

  do {
    const result = await deps.client.fetchPostingsPage(page, pageSize);
    totalCount = result.totalCount;
    totalPages = result.totalPages;

    if (result.items.length > 0) {
      const values = result.items.map((p) => mapPostingToRow(p, deps.ingestedAt));
      await deps.sink.insert({ table, values, format: "JSONEachRow" });
      rows += values.length;
    }
    page += 1;
  } while (page <= totalPages);

  return { pages: page - 1, rows, totalCount };
}
