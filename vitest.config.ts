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
    // Integration tests hit real ClickHouse; give them room beyond the 5s default.
    testTimeout: 30_000,
  },
});
