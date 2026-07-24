import "server-only";
import { createReadOnlyClient } from "@shared/clickhouse";
import { createAnalytics, type Analytics } from "@shared/analytics";

// The app-server analytics handle over the dedicated read-only ClickHouse user (SELECT on postings only).
// Memoized per isolate so the server actions reuse one client, mirroring trigger/chat.ts's agent-side singleton.
let singleton: Analytics | undefined;

export function getAnalytics(): Analytics {
  return (singleton ??= createAnalytics({ client: createReadOnlyClient() }));
}
