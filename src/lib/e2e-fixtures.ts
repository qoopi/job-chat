import type { StoredMessage } from "@/lib/chat-ui";

// The production placeholder for the E2E-only resume fixtures. The chat shell (chat/[id]/page.tsx)
// statically imports `e2eFixtureThread` from here so it type-checks and bundles the SAME way in every
// build - but this module carries ZERO test data (no fixture conversations, no `fx-*` insight cards). The
// real fixtures live in tests/e2e/chat-fixtures.ts; the E2E build (JOBCHAT_E2E=1) swaps THIS specifier for
// them via next.config `turbopack.resolveAlias`, so no test code ever enters a production bundle. In a
// production build the fixtures are never read (`page.tsx` only calls e2eFixtureThread when `e2e === true`,
// which isE2E() makes always-false in prod), so the throw is a fail-closed guard, never a live path -
// fully symmetric with the MockChatTransport stub in e2e-transport.ts.
export interface FixtureThread {
  title: string;
  messages: StoredMessage[];
}

export function e2eFixtureThread(conversationId: string): FixtureThread | null {
  void conversationId; // signature parity with the real fixtures; this stub is never called in production
  throw new Error(
    "e2eFixtureThread is available only in an E2E build (JOBCHAT_E2E=1).",
  );
}
