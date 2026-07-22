// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { closeAuthDialog } from "@/lib/auth-dialog";

// refresh #2 s8 (was AC-13): the guest cap is a warm register moment, VISIBLE at every message origin -
// the chat composer AND the landing composer - as an accent-soft card inviting a free account ("Create
// account"), NOT a red error and NOT a silent refusal. The composer stays ENABLED (no auto-open); a send
// while capped opens the dialog with the draft queued. Both external boundaries are mocked.
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream({ start: (c) => c.close() }),
);
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
  }),
}));

const sendMessageMock = vi.fn();
const startConversationMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (id: string, t: string) => sendMessageMock(id, t),
  mintChatToken: vi.fn(),
  startConversation: (t: string) => startConversationMock(t),
  ensureGuest: vi.fn(async () => "guest-1"),
  completeSignIn: vi.fn(async () => ({ ok: true })),
  listMyConversations: vi.fn(async () => []),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

// Google-only (017): the dialog's own onGoogle calls signIn.social; no email/password affordance is
// wired anywhere, so the mock offers only what the real authClient surface exposes now.
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { social: vi.fn() },
    signOut: vi.fn(),
    useSession: () => ({ data: null, isPending: false }),
  },
}));

import { ChatClient } from "@/components/chat/ChatClient";
import { LandingComposer } from "@/components/landing/LandingComposer";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  closeAuthDialog();
  sessionStorage.clear();
  sendMessageMock.mockReset();
  startConversationMock.mockReset();
});

test("Should_ShowRegisterCardAndKeepComposerEnabled_When_Capped: chat composer", async () => {
  sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", {
    name: "Ask a follow-up",
  }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "One more question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  const card = await waitFor(() => {
    const n = document.querySelector(".register-card");
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  expect(within(card).getByText(/reached the guest limit/i)).toBeTruthy();
  expect(
    within(card).getByRole("button", { name: "Create account" }),
  ).toBeTruthy();
  expect(document.querySelector(".notice")).toBeNull(); // not the grey error notice
  expect(screen.queryByRole("dialog")).toBeNull(); // the dialog does NOT auto-open
  // the composer stays ENABLED, with the register placeholder
  await waitFor(() => expect(box.disabled).toBe(false));
  expect(box.placeholder).toBe("Create an account to keep asking…");
});

// AC-9 (R3): a cap refusal persists NOTHING (the refused message never enters the thread); the capped
// state re-derives on the NEXT send attempt from the one refusal notice already in the thread. So a
// capped guest who sends again is re-refused with the SAME notice - no second server round trip, no
// second refusal turn appended, the composer still usable.
test("Should_Rerefuse_When_CappedUserSendsAgain", async () => {
  sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(
    <ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />,
  );
  const box = screen.getByRole("textbox", { name: "Ask a follow-up" }) as HTMLTextAreaElement;

  fireEvent.change(box, { target: { value: "One more question" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByText(/reached the guest limit/i);
  expect(sendMessageMock).toHaveBeenCalledTimes(1);

  // send again while capped: the SAME notice is still shown, re-refused WITHOUT a second server call
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  expect(screen.getByText(/reached the guest limit/i)).toBeTruthy();
  expect(sendMessageMock).toHaveBeenCalledTimes(1); // no second refusal round trip
  expect(document.querySelectorAll(".register-card")).toHaveLength(1); // exactly one notice, not doubled
});

test("Should_OpenDialogWithDraftQueued_When_SendWhileCapped: chat composer", async () => {
  sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", {
    name: "Ask a follow-up",
  }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "One more question" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByText(/reached the guest limit/i);

  // a send while capped opens the dialog and keeps the draft queued (does NOT hit the server again)
  fireEvent.keyDown(box, { key: "Enter" });
  expect(
    await screen.findByRole("dialog", { name: "Create your free account" }),
  ).toBeTruthy();
  expect(box.value).toBe("One more question");
  expect(sendMessageMock).toHaveBeenCalledTimes(1);
  // AC-D32 / ruling 1: the draft is stashed in sessionStorage so it survives the Google full-page redirect
  expect(
    sessionStorage.getItem(`jobchat_queued_draft:${CONVERSATION_ID}`),
  ).toBe("One more question");
});

// AC-D32: on the signed-in return (a full-page reload after the Google redirect), ChatClient takes the
// sessionStorage-carried draft and auto-sends it exactly once, then clears it. `fromAuth` marks the
// genuine post-auth arrival (set by /auth/complete) - the only navigation that may replay a queued draft.
test("Should_AutoSendQueuedDraft_When_SignInSucceedsAfterCap", async () => {
  sessionStorage.setItem(
    `jobchat_queued_draft:${CONVERSATION_ID}`,
    "Queued question",
  );
  sendMessageMock.mockResolvedValue({ ok: true });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
      signedIn
      accountName="Ada"
      fromAuth
    />,
  );

  await waitFor(() =>
    expect(sendMessageMock).toHaveBeenCalledWith(
      CONVERSATION_ID,
      "Queued question",
    ),
  );
  expect(sendMessageMock).toHaveBeenCalledTimes(1);
  expect(
    sessionStorage.getItem(`jobchat_queued_draft:${CONVERSATION_ID}`),
  ).toBeNull(); // cleared (once)
});

// Audit (05-testing, ruling 1 mutation check): takeQueuedDraft is a read-ONCE-and-clear. Prove the
// exactly-once guarantee lives at the sessionStorage layer itself, not just in the component's one-time
// mount ref - a SECOND ChatClient mount for the same conversation (a StrictMode double-invoke, or a real
// client remount) after the first already consumed the draft must NOT send it again.
test("Should_NotDoubleSend_When_TheSameConversationMountsASecondTime", async () => {
  sessionStorage.setItem(
    `jobchat_queued_draft:${CONVERSATION_ID}`,
    "Queued question",
  );
  sendMessageMock.mockResolvedValue({ ok: true });
  const first = render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
      signedIn
      accountName="Ada"
      fromAuth
    />,
  );
  await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
  first.unmount();

  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
      signedIn
      accountName="Ada"
      fromAuth
    />,
  );
  // give the second mount's microtask a turn to run, then confirm it did NOT re-send: the storage key
  // was already cleared by the first mount, so takeQueuedDraft returns null the second time.
  await Promise.resolve();
  await Promise.resolve();
  expect(sendMessageMock).toHaveBeenCalledTimes(1);
});

// Audit (05-testing, ruling 1): a refused/failed auto-send of the queued draft must not lose the text -
// it has to land back in the composer exactly like any other failed send (failSend), not vanish.
test("Should_KeepTextInComposer_When_AutoSentQueuedDraftIsRefused", async () => {
  sessionStorage.setItem(
    `jobchat_queued_draft:${CONVERSATION_ID}`,
    "Queued question",
  );
  sendMessageMock.mockResolvedValue({ ok: false, reason: "invalid_input" });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
      signedIn
      accountName="Ada"
      fromAuth
    />,
  );
  await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

  const box = screen.getByRole("textbox", {
    name: "Ask a follow-up",
  }) as HTMLTextAreaElement;
  await waitFor(() => expect(box.value).toBe("Queued question"));
  // cleared from storage regardless of outcome (read-once) - a retry types/sends again, it never re-fires itself
  expect(
    sessionStorage.getItem(`jobchat_queued_draft:${CONVERSATION_ID}`),
  ).toBeNull();
});

// Fix round, item 2: the "/chat/new" key is SHARED (conversationId "new"), unlike a real conversation's
// UUID. A capped guest stashes under "new" then ABANDONS the sign-in; LATER they arrive at /chat/new
// signed-in via an ORDINARY navigation (landing "Your profile" / "Open your chats"), NOT a post-auth
// return - so `fromAuth` is absent. That stale draft must NOT auto-send (no unintended conversation /
// budget burn); it is garbage-collected so it can never misfire on a subsequent real post-auth arrival.
test("Should_NotAutoSendStaleNewDraft_When_OrdinarySignedInMountFindsIt", async () => {
  sessionStorage.setItem(`jobchat_queued_draft:new`, "Abandoned question");
  render(
    <ChatClient
      conversationId="new"
      newChat
      initialMessages={[]}
      e2e={false}
      signedIn
      accountName="Ada"
    />,
  );
  // let the mount microtask run
  await Promise.resolve();
  await Promise.resolve();
  expect(sendMessageMock).not.toHaveBeenCalled();
  expect(startConversationMock).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(`jobchat_queued_draft:new`)).toBeNull();
});

// Fix round, master ruling (arrival side): a genuine "/chat/new" post-auth arrival (fromAuth) with a
// landing-stashed draft auto-sends it once via the fresh-chat path (startConversation), exactly like the
// chat path replays its queued draft. This is the landing cap moment carried across sign-in.
test("Should_AutoSendQueuedNewDraft_When_PostAuthArrivalAtChatNew", async () => {
  sessionStorage.setItem(`jobchat_queued_draft:new`, "Median salary in SF");
  startConversationMock.mockResolvedValue({ ok: true, conversationId: "co-1" });
  render(
    <ChatClient
      conversationId="new"
      newChat
      initialMessages={[]}
      e2e={false}
      signedIn
      accountName="Ada"
      fromAuth
    />,
  );
  await waitFor(() =>
    expect(startConversationMock).toHaveBeenCalledWith("Median salary in SF"),
  );
  expect(startConversationMock).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(`jobchat_queued_draft:new`)).toBeNull();
});

// Fix round, master ruling (stash side): the LANDING cap carries the blocked question across sign-in
// exactly like the chat path - a guest_cap on the landing stashes the draft under the "/chat/new"
// destination key so the post-auth arrival replays it (same sessionStorage mechanism as the chat path).
test("Should_QueueLandingDraftUnderNewKey_When_CappedOnLanding", async () => {
  startConversationMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(<LandingComposer e2e={false} />);
  const box = screen.getByRole("textbox", {
    name: "What are you looking for",
  }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Median salary in SF" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByText(/reached the guest limit/i);
  await waitFor(() =>
    expect(sessionStorage.getItem(`jobchat_queued_draft:new`)).toBe(
      "Median salary in SF",
    ),
  );
});

test("Should_ShowRegisterCardAndKeepComposerEnabled_When_Capped: landing composer", async () => {
  startConversationMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(<LandingComposer e2e={false} />);

  const box = screen.getByRole("textbox", {
    name: "What are you looking for",
  }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Top companies hiring" } });
  fireEvent.keyDown(box, { key: "Enter" });

  const card = await waitFor(() => {
    const n = document.querySelector(".register-card");
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  expect(
    within(card).getByRole("button", { name: "Create account" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull(); // no silent refusal, no auto-open
  await waitFor(() => expect(box.disabled).toBe(false)); // the input stays usable
});
