// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UIMessage, UIMessageChunk } from "ai";

// After a RESUMED mount, `useChat.stop()` alone does NOT
// reach the backend - the AI SDK does not thread an abort through `reconnectToStream`, so Bedrock keeps
// generating. Stop must pair `transport.stopGeneration(chatId)` (posts {kind:"stop"} on `.in`) with the
// AI SDK stop. This drives the real `useChat` down the resume path (a persisted mid-stream session ->
// `resume` -> `reconnectToStream` streams) and asserts clicking Stop calls `stopGeneration(chatId)`.
// Reverting the `stopGeneration` pairing in the composer's onStop turns this RED.

const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";

const stopGenerationMock = vi.fn(async () => true);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream<UIMessageChunk>({ start: (c) => c.close() }),
);
// A resumed stream that opens and then hangs (a turn still generating on the backend): status stays
// "streaming", so the composer shows Stop. Honors the AI SDK's abort so the test tears down cleanly.
const reconnectMock = vi.fn(
  async (opts: { abortSignal?: AbortSignal }) =>
    new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start" } as UIMessageChunk);
        opts.abortSignal?.addEventListener("abort", () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    }),
);

vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
    stopGeneration: stopGenerationMock,
  }),
}));

vi.mock("@/app/actions", () => ({
  sendMessage: vi.fn(),
  mintChatToken: vi.fn(async () => ({ ok: true, token: "tok" })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { ChatClient } from "@/components/chat/ChatClient";

const hydrated: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
];

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  stopGenerationMock.mockClear();
  reconnectMock.mockClear();
});

test("Should_StopReachBackend_When_StoppedAfterResume", async () => {
  // A persisted mid-stream session: `resume` is true, so useChat resumes on mount via reconnectToStream.
  window.sessionStorage.setItem(
    `jobchat_session:${CONVERSATION_ID}`,
    JSON.stringify({ publicAccessToken: "tok", isStreaming: true }),
  );

  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={hydrated}
      e2e={false}
    />,
  );

  // The resume path streamed, so the composer is in its streaming state with a Stop control.
  await waitFor(() => expect(reconnectMock).toHaveBeenCalled());
  const stopButton = await screen.findByRole("button", { name: "Stop" });

  fireEvent.click(stopButton);

  // Stop must reach the backend: stopGeneration is called with this conversation's id (paired with the
  // AI SDK stop). Without the pairing, only the local reader aborts and the backend keeps generating.
  await waitFor(() =>
    expect(stopGenerationMock).toHaveBeenCalledWith(CONVERSATION_ID),
  );
});
