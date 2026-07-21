import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": new URL("./shared", import.meta.url).pathname,
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      // Component tests opt into jsdom per-file via a `// @vitest-environment jsdom` docblock.
      "tests/component/**/*.test.tsx",
    ],
    setupFiles: ["tests/setup.env.ts"],
    // Integration tests hit real ClickHouse; give them room beyond the 5s default. 65s - just past
    // CLICKHOUSE_REQUEST_TIMEOUT_MS (60s, shared/clickhouse.ts AC-10) - so a cold-cloud wake the client
    // itself would survive is not instead killed early by vitest's OWN test-level timeout (023 testing
    // audit finding: the client's 60s fix was silently undercut by this 30s cap).
    testTimeout: 65_000,
  },
});
