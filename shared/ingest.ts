import type { ClickHouseClient } from "@clickhouse/client";
import { mapPostingToRow, toChDateTime, type PostingRow } from "./postings";
import type { SearchnapplyClient } from "./searchnapply";

// The write seam: structurally satisfied by @clickhouse/client (real client in prod, fake in tests).
export interface RowSink {
  insert(params: {
    table: string;
    values: PostingRow[];
    format: "JSONEachRow";
  }): Promise<unknown>;
  /** Delisting cleanup: drop snapshot rows older than the run's version. Keyed to the run timestamp, so it
   *  is overlap-safe - an older run's delete (a smaller `olderThan`) can never touch a newer snapshot. */
  deleteOlderThan(params: { table: string; olderThan: Date }): Promise<unknown>;
}

/** The production ClickHouse-backed sink (insert + delisting delete). One home for both prod and the
 *  integration test, so the delete SQL lives in a single place. */
export function createClickhouseRowSink(client: ClickHouseClient): RowSink {
  return {
    insert: (params) => client.insert(params),
    deleteOlderThan: ({ table, olderThan }) =>
      client.command({
        query: `DELETE FROM ${table} WHERE ingested_at < '${toChDateTime(olderThan)}'`,
        clickhouse_settings: { wait_end_of_query: 1 },
      }),
  };
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

  // Delisting cleanup: only reached after ALL pages inserted (a mid-run throw skips it). Keyed to THIS
  // run's version so it is idempotent across retries and overlap-safe (an older run cannot prune a newer snapshot).
  await deps.sink.deleteOlderThan({ table, olderThan: deps.ingestedAt });

  return { pages: page - 1, rows, totalCount };
}
