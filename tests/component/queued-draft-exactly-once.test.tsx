// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { closeAuthDialog } from "@/lib/auth-dialog";

// Audit focus (013 testing pass): AC-11's queued-draft auto-send must be EXACTLY-ONCE. ChatClient's
// `onAuthSuccess` (ChatClient.tsx) reads `queuedDraft` into a local var, clears it via `setQueuedDraft`,
// then sends it - but the read-then-clear is not atomic against React's batching: two synchronous
// `onSuccess()` calls (the real AuthDialog only fires one per submit, but a defensive contract should
// not depend on that) both close over the SAME pre-clear `queuedDraft` value. AuthDialog is replaced with
// a minimal stub here so the test can fire `onSuccess` twice directly, isolating ChatClient's contract
// from AuthDialog's own submit-guard (which is exercised for real in queued-draft.test.tsx).
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
vi.mock("@/app/actions", () => ({
  sendMessage: (id: string, t: string) => sendMessageMock(id, t),
  mintChatToken: vi.fn(),
  completeSignIn: vi.fn(async () => ({ ok: true })),
  listMyConversations: vi.fn(async () => []),
}));

// Stub the dialog: renders a button that fires `onSuccess` TWICE in one synchronous click handler,
// simulating a double-fired success callback (double-click, a re-entrant onSuccess, etc.) without
// going through the real form/loading-guard path.
vi.mock("@/components/auth/AuthDialog", () => ({
  AuthDialog: ({ onSuccess }: { onClose: () => void; onSuccess?: () => void }) => (
    <button
      type="button"
      onClick={() => {
        onSuccess?.();
        onSuccess?.();
      }}
    >
      fire-onSuccess-twice
    </button>
  ),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const composer = () => screen.getByRole("textbox", { name: "Ask a follow-up" }) as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
  closeAuthDialog();
  sendMessageMock.mockReset();
});

test("Should_SendQueuedDraftExactlyOnce_When_OnSuccessFiresTwice", async () => {
  sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "guest_cap" }); // the cap-hit
  sendMessageMock.mockResolvedValue({ ok: true, publicAccessToken: "tok-followup" }); // any auto-send

  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
  const box = composer();
  fireEvent.change(box, { target: { value: "Median DE salary in SF?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  const fireTwice = await screen.findByRole("button", { name: "fire-onSuccess-twice" });
  await act(async () => {
    fireEvent.click(fireTwice);
    await Promise.resolve(); // flush the microtask queue so both onAuthSuccess invocations settle
  });

  // 1 cap-hit + at most 1 auto-send = 2 total. A third call means the queued draft double-sent.
  expect(sendMessageMock).toHaveBeenCalledTimes(2);
  expect(sendMessageMock.mock.calls[1]).toEqual([CONVERSATION_ID, "Median DE salary in SF?"]);
});
