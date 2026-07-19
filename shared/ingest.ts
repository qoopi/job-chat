import { mapPostingToRow, type PostingRow } from "./postings";
import type { SearchnapplyClient } from "./searchnapply";

// The insert target. Structurally satisfied by @clickhouse/client's `insert`,
// so the trigger task passes the real client and tests pass a collecting fake.
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

/**
 * Page the jobs-api and insert one JSONEachRow batch per page into `table`.
 * Idempotent by design: ReplacingMergeTree keyed (source, external_id) collapses
 * re-pulls. A mid-run page/insert failure propagates (the Trigger.dev run fails
 * and retries), leaving already-inserted batches intact (AC-2).
 */
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
