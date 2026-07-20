// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { closeAuthDialog } from "@/lib/auth-dialog";

// AC-11 (UI slice): a guest hits the cap -> the blocked draft is queued and the dialog opens. On a
// successful in-page sign-in the queued draft auto-sends through the NORMAL guarded path: if the guard
// now passes it streams; if the signed-in cap still refuses, the standard notice shows and the draft
// stays in the composer. External boundaries mocked as chat-client.test.tsx; auth is mocked to succeed.
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
const completeSignInMock = vi.fn(async () => ({ ok: true }));
const listMyConversationsMock = vi.fn(async () => []);
vi.mock("@/app/actions", () => ({
  sendMessage: (id: string, t: string) => sendMessageMock(id, t),
  mintChatToken: vi.fn(),
  completeSignIn: () => completeSignInMock(),
  listMyConversations: () => listMyConversationsMock(),
}));

const signInEmailMock = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: (a: unknown) => signInEmailMock(a), social: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    useSession: () => ({ data: null, isPending: false }),
  },
}));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const composer = () => screen.getByRole("textbox", { name: "Ask a follow-up" }) as HTMLTextAreaElement;

async function hitCapThenSignIn(secondSendResult: unknown) {
  sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "guest_cap" });
  sendMessageMock.mockResolvedValueOnce(secondSendResult);
  signInEmailMock.mockResolvedValue({ error: null });

  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
  const box = composer();
  fireEvent.change(box, { target: { value: "Median DE salary in SF?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByRole("dialog", { name: "Sign in to jobchat.dev" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

afterEach(() => {
  cleanup();
  closeAuthDialog();
  sendMessageMock.mockReset();
  signInEmailMock.mockReset();
  setSessionMock.mockClear();
  sendMessagesMock.mockClear();
});

test("Should_AutoSendQueuedDraft_When_GuardsPass", async () => {
  await hitCapThenSignIn({ ok: true, publicAccessToken: "tok-followup" });

  // adoption transition ran, then the queued draft was re-sent through the guarded action
  await waitFor(() => expect(completeSignInMock).toHaveBeenCalled());
  await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
  expect(sendMessageMock.mock.calls[1]).toEqual([CONVERSATION_ID, "Median DE salary in SF?"]);

  // the guard passed -> the turn streams (transport hydrated with the fresh token, then delivered)
  await waitFor(() =>
    expect(setSessionMock).toHaveBeenCalledWith(
      CONVERSATION_ID,
      expect.objectContaining({ publicAccessToken: "tok-followup", isStreaming: true }),
    ),
  );
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull(); // dialog closed on success
});

test("Should_KeepDraftWithNotice_When_SignedInGuardRefuses", async () => {
  await hitCapThenSignIn({ ok: false, reason: "guest_cap" });

  await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
  // the signed-in guard still refused: the polite notice shows, the dialog does NOT re-open, and the
  // draft is preserved in the composer for the user to edit/retry.
  await waitFor(() => expect(document.querySelector(".notice")).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(composer().value).toBe("Median DE salary in SF?");
});
