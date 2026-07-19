// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";

// ChatClient.send() has TWO distinct paths that can produce a cap/budget refusal (decision 19 / 004
// handoff): the E2E/agent-side path (the transport streams a `data-refusal` part mid-run - covered by
// e2e `live-chat-loop.spec.ts::AC-15`) and the PROD action-side path (the `sendMessage` server action
// itself returns `{ ok: false, reason }` BEFORE any run starts, and ChatClient synthesizes the same
// `data-refusal` part via `setMessages`). Only the first path had a test; this closes the gap on the
// second one - it must render the identical notice, through the identical MessageList/RefusalNotice
// path, not a bespoke banner. The real transport and server action are mocked (external boundaries);
// ChatClient's own branching is what is under test.
//
// It also proves the attach contract: a prod turn only streams once the transport's session cache is
// HYDRATED - `setSession(chatId, { publicAccessToken, isStreaming: true })` must run BEFORE the send.
// A follow-up delivers + watches via `sendMessages` (mechanism a, 004 round 3) - the only SDK path that
// streams a freshly-triggered turn live; the peekSettled `reconnectToStream` is NOT used for follow-ups.
// Arrival still attaches via `reconnectToStream` (resumeStream on an in-flight run). All three are spied.
const setSessionMock = vi.fn();
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(async () => new ReadableStream({ start: (c) => c.close() }));
const getSessionMock = vi.fn(() => undefined);
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
    setSession: setSessionMock,
    getSession: getSessionMock,
  }),
}));

const sendMessageMock = vi.fn();
const mintChatTokenMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (conversationId: string, text: string) => sendMessageMock(conversationId, text),
  mintChatToken: (conversationId: string) => mintChatTokenMock(conversationId),
}));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  mintChatTokenMock.mockReset();
  setSessionMock.mockClear();
  reconnectMock.mockClear();
  sendMessagesMock.mockClear();
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
  // A refusal short-circuits BEFORE any attach - the transport must never be touched.
  expect(setSessionMock).not.toHaveBeenCalled();
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

// --- mechanism (a): a follow-up delivers + watches via sendMessages, hydrated first ---

test("follow-up send: the action's session token hydrates the transport BEFORE the deliver+watch send (streams live, not peekSettled reconnect)", async () => {
  sendMessageMock.mockResolvedValue({ ok: true, publicAccessToken: "tok-followup" });
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "Any remote roles?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByText("Any remote roles?"); // optimistic user bubble (useChat.sendMessage adds it)
  await waitFor(() => expect(setSessionMock).toHaveBeenCalled());

  // The action's scoped token hydrates the session so `sendMessages` attaches with it.
  expect(setSessionMock).toHaveBeenCalledWith(
    CONVERSATION_ID,
    expect.objectContaining({ publicAccessToken: "tok-followup", isStreaming: true }),
  );
  // Delivered + watched via sendMessages (append + subscribe-with-wait), NOT the peekSettled reconnect.
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
  expect(reconnectMock).not.toHaveBeenCalled();
  // Ordering: hydrate, THEN send (else the transport attaches with no cached session token).
  expect(setSessionMock.mock.invocationCallOrder[0]).toBeLessThan(sendMessagesMock.mock.invocationCallOrder[0]);
});

test("arrival: a new chat mints its session token and hydrates the transport so the first run streams on mount (AC-3)", async () => {
  mintChatTokenMock.mockResolvedValue({ ok: true, token: "tok-arrival" });
  const initial: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Which companies are hiring the most?" }] }];
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={initial} autoStream e2e={false} />);

  await waitFor(() => expect(setSessionMock).toHaveBeenCalled());
  expect(mintChatTokenMock).toHaveBeenCalledWith(CONVERSATION_ID);
  expect(setSessionMock).toHaveBeenCalledWith(
    CONVERSATION_ID,
    expect.objectContaining({ publicAccessToken: "tok-arrival", isStreaming: true }),
  );
  await waitFor(() => expect(reconnectMock).toHaveBeenCalled());
  expect(setSessionMock.mock.invocationCallOrder[0]).toBeLessThan(reconnectMock.mock.invocationCallOrder[0]);
});
