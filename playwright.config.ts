import { defineConfig } from "@playwright/test";

// E2E runs against the local dev server with NETWORK MOCKS (page.route) - no cloud services needed.
// Port 3111 to avoid colliding with other local apps on 3000.
export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:3111" },
  outputDir: "./tests/test-results",
  webServer: {
    // next dev daemonizes in Next 16 (parent exits -> Playwright thinks it failed), so e2e runs
    // against the production server. For a fast local loop: run `bunx next dev --port 3111`
    // yourself - reuseExistingServer picks it up and skips the build.
    command: "bunx next build && bunx next start --port 3111",
    url: "http://localhost:3111",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
