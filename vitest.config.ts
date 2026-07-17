import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@shared": new URL("./shared", import.meta.url).pathname } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
