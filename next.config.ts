import type { NextConfig } from "next";

// JOBCHAT_E2E build swap: the E2E Playwright build (JOBCHAT_E2E=1) resolves the app's two test seams -
// the transport (`@/lib/e2e-transport`) and the resume fixtures (`@/lib/e2e-fixtures`) - to the REAL
// scripted mock + fixtures in tests/; every other build keeps the production stubs
// (src/lib/e2e-transport.ts, src/lib/e2e-fixtures.ts), so no test code - the mock transport, its
// chunk-replay machinery, or the fixture conversations - ever enters a production bundle. The swap is
// build-time (Turbopack resolveAlias), which is why the test-only bundle tokens ("__CHAT_REPLAY__" from
// the mock, "fx-histogram" from the fixtures) are present in the e2e build and absent from the prod build.
const e2eBuild = process.env.JOBCHAT_E2E === "1";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: e2eBuild
      ? {
          "@/lib/e2e-transport": "./tests/e2e/mock-transport.ts",
          "@/lib/e2e-fixtures": "./tests/e2e/chat-fixtures.ts",
        }
      : {},
  },
};

export default nextConfig;
