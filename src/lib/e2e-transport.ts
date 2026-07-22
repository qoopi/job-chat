"use client";

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { ChatSessionPersistedState } from "@trigger.dev/sdk/chat";

// The production placeholder for the E2E-only mock transport. The app's single transport seam
// (chat-transport.ts) statically imports `MockChatTransport` from here so it type-checks and bundles the
// SAME way in every build - but this module carries ZERO test code (no chunk scripts, no `__CHAT_REPLAY__`
// replay machinery). The real scripted mock lives in tests/e2e/mock-transport.ts; the E2E build
// (JOBCHAT_E2E=1) swaps THIS specifier for it via next.config `turbopack.resolveAlias`, so no test code
// ever enters a production bundle. In a production build the mock is never constructed
// (`useJobChatTransport` only news it up when `e2e === true`), so the throw is a fail-closed guard, never
// a live path.
export class MockChatTransport implements ChatTransport<UIMessage> {
  constructor(hydrated?: Record<string, ChatSessionPersistedState>) {
    void hydrated; // signature parity with the real mock; this stub is never constructed in production
    throw new Error(
      "MockChatTransport is available only in an E2E build (JOBCHAT_E2E=1).",
    );
  }

  sendMessages = async (): Promise<ReadableStream<UIMessageChunk>> => {
    throw new Error("MockChatTransport is E2E-only.");
  };

  reconnectToStream = async (): Promise<ReadableStream<UIMessageChunk> | null> => null;

  stopGeneration = async (): Promise<boolean> => true;
}
