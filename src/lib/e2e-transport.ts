"use client";

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { ChatSessionPersistedState } from "@trigger.dev/sdk/chat";

// Production placeholder for the E2E-only mock transport (ZERO test code); the E2E build swaps this for tests/e2e/mock-transport.ts. The throw is a fail-closed guard.
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
