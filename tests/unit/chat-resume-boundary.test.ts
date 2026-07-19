import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// AC-13's "resume renders from the store with NO re-run of analytics" is a static property of the
// resume code path, not something a Playwright network listener can observe: ClickHouse is only ever
// called from the Next.js server process (shared/analytics.ts + shared/clickhouse.ts), so a real
// re-query regression would never surface as a page-level browser request. chat-resume.spec.ts's
// `page.on("request")` check therefore passes vacuously in E2E mode regardless of whether the resume
// path is correct (E2E resume reads the in-memory fixture and makes no network call of any kind to
// begin with). This test asserts the actual invariant directly: the resume chain (chat page -> server
// store -> fixture/hydration) never imports the ClickHouse client or the analytics query module, so a
// regression that adds a re-query on resume fails HERE, not silently.
const FORBIDDEN: [name: string, pattern: RegExp][] = [
  ["@clickhouse/client", /@clickhouse\/client/],
  ["the analytics query module", /shared\/analytics/],
];

const RESUME_CHAIN_FILES = [
  "src/app/chat/[id]/page.tsx",
  "src/lib/server-store.ts",
  "src/lib/chat-fixtures.ts",
  "src/lib/chat-ui.ts",
];

describe("AC-13 resume path never touches analytics (import boundary)", () => {
  for (const relPath of RESUME_CHAIN_FILES) {
    it(`${relPath} imports neither ClickHouse nor the analytics module`, () => {
      const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
      for (const [name, pattern] of FORBIDDEN) {
        expect(src, `${relPath} unexpectedly references ${name}`).not.toMatch(pattern);
      }
    });
  }
});
