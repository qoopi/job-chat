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

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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

// Audit focus (013 testing pass): completeSignIn's TRANSITION (adopt + cookie-clear) can fail (see
// tests/unit/complete-sign-in.test.ts for the server-side sequencing). AuthDialog's onSubmit catches the
// rejection and shows a generic error WITHOUT calling onSuccess - so ChatClient's queued draft must
// survive untouched and the dialog must stay open (no auto-send attempt), not silently lose the request.
test("Should_KeepQueuedDraftAndDialogOpen_When_AdoptionFails", async () => {
  sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "guest_cap" });
  signInEmailMock.mockResolvedValue({ error: null });
  completeSignInMock.mockRejectedValueOnce(new Error("adoption store failure"));

  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
  const box = composer();
  fireEvent.change(box, { target: { value: "Median DE salary in SF?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByRole("dialog", { name: "Sign in to jobchat.dev" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(completeSignInMock).toHaveBeenCalled());
  await screen.findByText("Something went wrong. Try again."); // AuthDialog's catch-path error

  // no auto-send was attempted (only the original cap-hit call), the dialog is still up, and the
  // blocked draft is exactly what it was - nothing lost, nothing double-queued.
  expect(sendMessageMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(composer().value).toBe("Median DE salary in SF?");
});

// Nit (review): completeSignIn returning `{ok:false}` (the session is not yet visible server-side) must
// NOT be treated as success - `succeed()` now consumes `{ok}`, so it shows an inline error and does not
// fire onSuccess. The dialog stays open, no auto-send fires, and the queued draft stays intact - the same
// stay-open guarantee as the throw path above, just for the non-throwing `{ok:false}` return.
test("Should_KeepDialogOpenWithError_When_CompleteSignInReturnsNotOk", async () => {
  sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "guest_cap" });
  signInEmailMock.mockResolvedValue({ error: null });
  completeSignInMock.mockResolvedValueOnce({ ok: false }); // session not yet visible server-side

  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
  const box = composer();
  fireEvent.change(box, { target: { value: "Median DE salary in SF?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByRole("dialog", { name: "Sign in to jobchat.dev" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(completeSignInMock).toHaveBeenCalled());
  await screen.findByText(/couldn't finish signing you in/i); // inline error, dialog stays open

  expect(sendMessageMock).toHaveBeenCalledTimes(1); // only the cap-hit - no auto-send
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(composer().value).toBe("Median DE salary in SF?");
});

// Review (final-review 013): the queued auto-send is ARMED at the cap moment but disarmed only on auth
// SUCCESS. A guest who hits the cap, then CANCELS the dialog (rather than signing in), left the queue
// armed - so a much-later, unrelated sidebar sign-in auto-fired the stale blocked question with no
// intent. Dismissing the dialog must disarm the queued auto-send (the draft itself stays visible in the
// composer for the user to edit/retry); only a sign-in that follows directly from the cap prompt should
// auto-continue.
test("Should_NotAutoSendStaleDraft_When_DialogCanceledThenSignInLater", async () => {
  sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "guest_cap" }); // the cap-hit (the only send expected)
  signInEmailMock.mockResolvedValue({ error: null });

  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
  const box = composer();
  fireEvent.change(box, { target: { value: "Median DE salary in SF?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  // guest cap -> the dialog opens with the blocked draft queued for auto-send
  await screen.findByRole("dialog", { name: "Sign in to jobchat.dev" });

  // the guest CANCELS instead of signing in - this must disarm the queued auto-send...
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(composer().value).toBe("Median DE salary in SF?"); // ...but the draft stays visible in the composer

  // much later, an unrelated sidebar sign-in (no fresh cap-hit re-arms the queue)
  fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[0]);
  await screen.findByRole("dialog", { name: "Sign in to jobchat.dev" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  // sign-in succeeds and the dialog closes (onAuthSuccess's synchronous body, incl. any auto-send, has
  // run by the time the dialog is gone) - the stale blocked draft must NOT have auto-sent.
  await waitFor(() => expect(completeSignInMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(sendMessageMock).toHaveBeenCalledTimes(1); // only the original cap-hit; no stale auto-send
});
