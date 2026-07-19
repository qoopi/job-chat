// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage, UIMessageChunk } from "ai";

// Reproduces the operator's live-walk #2/#3 (routed to 004): a follow-up in an ONGOING chat is
// DELIVERED but never STREAMS live. Root, verified in the SDK source (dist/esm/v3/chat.js):
// `reconnectToStream` (what `useChat.resumeStream()` drives) hardcodes `peekSettled:true` (line ~556) -
// the reload-resume shortcut. Attaching to a run triggered milliseconds earlier, it re-reads the
// SETTLED prior turn / holds open and NEVER delivers the fresh run's chunks. The answer persists
// (renders on reload) but never streams. The fix routes a follow-up through the transport's
// `sendMessages` (append to `.in` + subscribe with `sinceInSeq`, NO peekSettled = wait-for-output) -
// the ONLY SDK primitive that streams a freshly-triggered follow-up live.
//
// This drives the REAL `useChat` merge against a transport that mirrors that exact split:
//   - reconnectToStream (peekSettled): re-emits ONLY the settled prior assistant turn, never the fresh one.
//   - sendMessages (subscribe-with-wait): streams the fresh follow-up answer.
// Pre-fix the follow-up uses resumeStream -> reconnect -> the fresh marker never appears (RED).
// Post-fix it uses sendMessages -> the fresh marker streams (GREEN).

const FRESH = "FRESH-FOLLOWUP-ANSWER";
const SETTLED = "settled prior answer";

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

const freshChunks: UIMessageChunk[] = [
  { type: "start", messageId: "fresh-1" } as UIMessageChunk,
  { type: "text-start", id: "f" } as UIMessageChunk,
  { type: "text-delta", id: "f", delta: FRESH } as UIMessageChunk,
  { type: "text-end", id: "f" } as UIMessageChunk,
  { type: "finish" } as UIMessageChunk,
];

// What peekSettled hands back for a run triggered milliseconds ago: the SETTLED prior turn, re-emitted
// under its own id - never the fresh run's output.
const settledChunks: UIMessageChunk[] = [
  { type: "start", messageId: "a1" } as UIMessageChunk,
  { type: "text-start", id: "p" } as UIMessageChunk,
  { type: "text-delta", id: "p", delta: SETTLED } as UIMessageChunk,
  { type: "text-end", id: "p" } as UIMessageChunk,
  { type: "finish" } as UIMessageChunk,
];

const sendMessagesSpy = vi.fn();
const reconnectSpy = vi.fn();

vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: async (): Promise<ReadableStream<UIMessageChunk>> => {
      sendMessagesSpy();
      return streamOf(freshChunks);
    },
    reconnectToStream: async (): Promise<ReadableStream<UIMessageChunk>> => {
      reconnectSpy();
      return streamOf(settledChunks); // peekSettled: only the settled prior turn, never the fresh one
    },
    setSession: () => {},
    getSession: () => undefined,
  }),
}));

const sendMessageMock = vi.fn();
const mintChatTokenMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (conversationId: string, text: string) => sendMessageMock(conversationId, text),
  mintChatToken: (conversationId: string) => mintChatTokenMock(conversationId),
}));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";

const hydrated: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: SETTLED }] },
];

afterEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  mintChatTokenMock.mockReset();
  sendMessagesSpy.mockClear();
  reconnectSpy.mockClear();
});

test("a follow-up in an ongoing chat STREAMS the fresh answer live (deliver+watch via sendMessages, not peekSettled reconnect)", async () => {
  sendMessageMock.mockResolvedValue({ ok: true, publicAccessToken: "tok-followup" });

  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={hydrated} e2e={false} />);

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "And their remote roles?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  // The gate action ran; the optimistic user turn shows.
  await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith(CONVERSATION_ID, "And their remote roles?"));
  await screen.findByText("And their remote roles?");

  // The fresh answer must STREAM live - this is the whole bug. Pre-fix the follow-up attaches via the
  // peekSettled reconnect, which returns only the settled prior turn, so this never appears.
  expect(await screen.findByText(FRESH)).toBeTruthy();

  // It streamed through the deliver+watch primitive, not the peekSettled reconnect path.
  expect(sendMessagesSpy).toHaveBeenCalled();
  expect(reconnectSpy).not.toHaveBeenCalled();
});
