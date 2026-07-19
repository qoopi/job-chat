// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// ChatClient.send() has TWO distinct paths that can produce a cap/budget refusal (decision 19 / 004
// handoff): the E2E/agent-side path (the transport streams a `data-refusal` part mid-run - covered by
// e2e `live-chat-loop.spec.ts::AC-15`) and the PROD action-side path (the `sendMessage` server action
// itself returns `{ ok: false, reason }` BEFORE any run starts, and ChatClient synthesizes the same
// `data-refusal` part via `setMessages`). Only the first path had a test; this closes the gap on the
// second one - it must render the identical notice, through the identical MessageList/RefusalNotice
// path, not a bespoke banner. The real transport and server action are mocked (external boundaries);
// ChatClient's own branching is what is under test.
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: async () => new ReadableStream({ start: (c) => c.close() }),
    reconnectToStream: async () => null,
  }),
}));

const sendMessageMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (conversationId: string, text: string) => sendMessageMock(conversationId, text),
}));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  sendMessageMock.mockReset();
});

test("action-refusal: the sendMessage action's cap refusal renders the SAME limit notice as the agent-side refusal", async () => {
  sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "One more question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(await screen.findByText(/reached the guest message limit/i)).toBeTruthy();
  expect(document.querySelector(".notice")).toBeTruthy();
  expect(document.querySelector(".err-card")).toBeNull();
  expect(sendMessageMock).toHaveBeenCalledWith(CONVERSATION_ID, "One more question");
});

test("action-refusal: an ok send does NOT render a notice (control case)", async () => {
  sendMessageMock.mockResolvedValue({
    ok: true,
    conversationId: CONVERSATION_ID,
    messageId: "m1",
    publicAccessToken: "tok",
    runId: "run1",
  });
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "A normal question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByText("A normal question"); // the optimistic user bubble renders
  expect(document.querySelector(".notice")).toBeNull();
});
