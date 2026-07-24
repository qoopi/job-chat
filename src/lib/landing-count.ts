import "server-only";
import { unstable_cache } from "next/cache";
import { getAnalytics } from "./analytics-server";

// The landing tagline's live open-postings count. Wrapped in the Next data cache and revalidated every 15
// minutes, so a visit reads the cached value and never wakes ClickHouse per request. A fetch failure
// resolves to null so the tagline renders WITHOUT a number (never a stale or invented count).
const REVALIDATE_SECONDS = 900;

export const getLivePostingCount = unstable_cache(
  async (): Promise<number | null> => {
    try {
      const { total } = await getAnalytics().coverageProfile();
      return Number.isFinite(total) ? total : null;
    } catch {
      return null; // ClickHouse unreachable / cold - render the line number-free rather than stale
    }
  },
  ["landing-live-posting-count"],
  { revalidate: REVALIDATE_SECONDS },
);
