import type { NextConfig } from "next";

// JOBCHAT_E2E build swap: the E2E Playwright build (JOBCHAT_E2E=1) resolves the app's transport seam
// (`@/lib/e2e-transport`) to the REAL scripted mock in tests/; every other build keeps the production stub
// (src/lib/e2e-transport.ts), so no test code - the mock transport, its chunk-replay machinery - ever
// enters a production bundle. The swap is build-time (Turbopack resolveAlias), which is why a mock-only
// bundle token ("__CHAT_REPLAY__") is present in the e2e build and absent from the prod build.
const e2eBuild = process.env.JOBCHAT_E2E === "1";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: e2eBuild
      ? { "@/lib/e2e-transport": "./tests/e2e/mock-transport.ts" }
      : {},
  },
};

export default nextConfig;
