import type { StoredMessage } from "@/lib/chat-ui";

// Production placeholder for the E2E-only fixtures (ZERO test data); the E2E build swaps this for tests/e2e/chat-fixtures.ts. The throw is a fail-closed guard.
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
