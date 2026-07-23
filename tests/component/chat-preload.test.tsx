// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { UIMessage } from "ai";

// AC-2 (register #11): the cold-start warm. On a fresh mount of a REAL conversation ChatClient calls the
// transport's `preload(chatId)` ONCE, so the Trigger session/run boot overlaps the mount + first turn
// instead of stacking after the send. The warm is guarded away where it would be junk or pointless: the
// e2e mock (no real session to warm), a `/chat/new` shell (its id is a throwaway placeholder replaced when
// the first send mints the real conversation), and a resuming mount (already warm). The transport +
// server actions + router are mocked as the sibling ChatClient tests do; ChatClient's own effect is what
// is under test. `preload` NEVER writes a PG row - it runs the SDK's startSession (createStartSessionAction)
// which creates only the Trigger session; that is asserted structurally in trigger/session at the store seam.
const preloadMock = vi.fn(async () => {});
const sendMessagesMock = vi.fn(async () => new ReadableStream({ start: (c) => c.close() }));
const reconnectMock = vi.fn(async () => null);
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    preload: preloadMock,
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
    stopGeneration: vi.fn(async () => true),
  }),
}));

vi.mock("@/app/actions", () => ({
  sendMessage: vi.fn(),
  mintChatToken: vi.fn(),
  startConversation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  preloadMock.mockClear();
  sendMessagesMock.mockClear();
  reconnectMock.mockClear();
  window.sessionStorage.clear();
});

test("warms the session ONCE on a fresh real-conversation mount, with the conversation id the first send will use", () => {
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
  expect(preloadMock).toHaveBeenCalledTimes(1);
  expect(preloadMock).toHaveBeenCalledWith(CONVERSATION_ID);
});

test("a re-render does NOT re-warm (once per mount, not per render)", () => {
  const { rerender } = render(
    <ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} title="A" />,
  );
  expect(preloadMock).toHaveBeenCalledTimes(1);
  // A prop-change re-render must not fire a second preload (the mount-once ref + [] effect hold).
  rerender(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} title="B" />);
  expect(preloadMock).toHaveBeenCalledTimes(1);
});

test("the landing-handoff arrival (?q=) still warms the exact session the first turn uses", () => {
  const initial: UIMessage[] = [
    { id: "msg-1", role: "user", parts: [{ type: "text", text: "Top companies hiring?" }] },
  ];
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={initial}
      pendingQuestion="Top companies hiring?"
      e2e={false}
    />,
  );
  expect(preloadMock).toHaveBeenCalledTimes(1);
  expect(preloadMock).toHaveBeenCalledWith(CONVERSATION_ID);
});

test("a '/chat/new' shell does NOT warm - its id is a throwaway placeholder, not the conversation the send mints", () => {
  render(<ChatClient conversationId="new" initialMessages={[]} newChat e2e={false} />);
  expect(preloadMock).not.toHaveBeenCalled();
});

test("the e2e build does NOT warm - the mock transport owns no real session", () => {
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={true} />);
  expect(preloadMock).not.toHaveBeenCalled();
});

test("a resuming (still-streaming) mount does NOT warm - the session is already live", () => {
  window.sessionStorage.setItem(
    `jobchat_session:${CONVERSATION_ID}`,
    JSON.stringify({ publicAccessToken: "tok", isStreaming: true }),
  );
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
  expect(preloadMock).not.toHaveBeenCalled();
});
