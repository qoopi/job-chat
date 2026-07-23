import { schedules } from "@trigger.dev/sdk";
import { createWriterClient } from "@shared/clickhouse";
import { createClickhouseRowSink, ingestPostings } from "@shared/ingest";
import { createSearchnapplyClient, searchnapplyConfigFromEnv } from "@shared/searchnapply";

// Scheduled ingest: searchnapply postings -> ClickHouse `postings`.
// Idempotent by table key (ReplacingMergeTree); the run's timestamp is the version.
export const ingestPostingsTask = schedules.task({
  id: "ingest-postings",
  // Hourly, on the hour: a 30-min cadence woke ClickHouse ~48x/day and
  // defeated idling; hourly keeps the corpus fresh while letting the service idle for credit control.
  cron: "0 * * * *",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
  run: async (payload) => {
    const client = createSearchnapplyClient(searchnapplyConfigFromEnv());
    const ch = createWriterClient();
    const sink = createClickhouseRowSink(ch);
    try {
      return await ingestPostings({ client, sink, ingestedAt: payload.timestamp });
    } finally {
      await ch.close();
    }
  },
});
