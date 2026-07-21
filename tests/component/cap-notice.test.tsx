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
const setSessionMock = vi.fn();
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream({ start: (c) => c.close() }),
);
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
// sessionStorage-carried draft and auto-sends it exactly once, then clears it.
test("Should_AutoSendQueuedDraft_When_SignInSucceedsAfterCap", async () => {
  sessionStorage.setItem(
    `jobchat_queued_draft:${CONVERSATION_ID}`,
    "Queued question",
  );
  sendMessageMock.mockResolvedValue({ ok: true, publicAccessToken: "tok" });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
      signedIn
      accountName="Ada"
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
