// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// The app's ONE transport seam (this file's subject, chat-transport.ts) statically
// imports `MockChatTransport` from the production stub `src/lib/e2e-transport.ts`, whose constructor
// throws unconditionally ("MockChatTransport is available only in an E2E build"). The stub is safe only
// because `useJobChatTransport` gates construction behind the `e2e` flag (`e2e ? new MockChatTransport(...)
// : null`) - but nothing exercised `useJobChatTransport` itself: every component test (chat-client,
// chat-dedup, ...) mocks `@/lib/chat-transport` out WHOLESALE, so the real gating branch was never run.
// This proves both halves of that gate directly, with the REAL (unmocked) chat-transport.ts and
// e2e-transport.ts modules: prod (e2e=false) never reaches the stub's constructor (no throw), and the
// stub's throw is reachable ONLY when e2e=true with no build-time alias in place (the exact reason the
// seam needs next.config's turbopack.resolveAlias swap for a real Playwright e2e build, not a runtime
// import).

const sendMessagesMock = vi.fn();
const reconnectToStreamMock = vi.fn();
const REAL_TRANSPORT = {
  sendMessages: sendMessagesMock,
  reconnectToStream: reconnectToStreamMock,
  stopGeneration: vi.fn(),
};

// The Trigger.dev SDK's real transport hook - an external boundary, mocked so this test drives only
// chat-transport.ts's own branching (the e2e ternary), not the SDK's internals. Capture the options so the
// canonical multiTab flag (item 5) can be pinned.
let capturedOptions: Record<string, unknown> | undefined;
vi.mock("@trigger.dev/sdk/chat/react", () => ({
  useTriggerChatTransport: (options: Record<string, unknown>) => {
    capturedOptions = options;
    return REAL_TRANSPORT;
  },
}));

// The server actions module ("use server": postgres + next/headers at import time) - mocked exactly as
// every other chat-transport consumer test mocks it (chat-client.test.tsx et al.); irrelevant here since
// useTriggerChatTransport itself is mocked above and never calls these callbacks during render.
vi.mock("@/app/actions", () => ({
  mintChatToken: vi.fn(),
  startChatSession: vi.fn(),
}));

import { useJobChatTransport } from "@/lib/chat-transport";

describe("useJobChatTransport - the e2e construction gate (027 audit)", () => {
  it("prod path (e2e=false) never constructs the E2E stub: no throw, real transport returned", () => {
    const { result } = renderHook(() =>
      useJobChatTransport({ e2e: false, conversationId: "c1" }),
    );
    expect(result.current).toBe(REAL_TRANSPORT);
  });

  // Item 5: multiTab: true is the canonical two-tab guard (BroadcastChannel claims the chatId so other tabs
  // go read-only, preventing a double-send). Pinned so a future edit that drops it fails loudly.
  it("passes multiTab: true to the SDK transport (the canonical two-tab guard)", () => {
    renderHook(() => useJobChatTransport({ e2e: false, conversationId: "c1" }));
    expect(capturedOptions?.multiTab).toBe(true);
  });

  // e2e=true DOES construct the seam's MockChatTransport import - which is the production STUB here (no
  // Turbopack resolveAlias in a plain vitest run), so its unconditional throw fires; this is exactly why
  // the real e2e build needs the build-time alias swap, not a runtime flag alone.
  it("e2e=true without the build-time alias hits the stub's fail-closed throw", () => {
    expect(() =>
      renderHook(() => useJobChatTransport({ e2e: true, conversationId: "c1" })),
    ).toThrow(/MockChatTransport is available only in an E2E build/);
  });
});
