// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { closeAuthDialog } from "@/lib/auth-dialog";

// AC-13 (UI slice): a guest cap refusal is VISIBLE at EVERY message origin - the chat composer AND the
// landing composer - as a polite notice with a sign-in affordance (no silent refusal), and the input is
// briefly disabled against an Enter-repeat (the dialog auto-opens, so the composer is inert). Both
// external boundaries are mocked; the assertion is the same at both origins.
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
  sendMessageMock.mockReset();
  startConversationMock.mockReset();
});

test("Should_ShowCapNoticeEverywhere_When_Capped: chat composer", async () => {
  sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "One more question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  const notice = await waitFor(() => {
    const n = document.querySelector(".notice");
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  expect(within(notice).getByText(/reached the guest message limit/i)).toBeTruthy();
  expect(within(notice).getByRole("button", { name: "Sign in" })).toBeTruthy(); // sign-in affordance
  expect(box.disabled).toBe(true); // brief disable against Enter-repeat
});

test("Should_ShowCapNoticeEverywhere_When_Capped: landing composer", async () => {
  startConversationMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(<LandingComposer e2e={false} />);

  const box = screen.getByRole("textbox", { name: "What are you looking for" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Top companies hiring" } });
  fireEvent.keyDown(box, { key: "Enter" });

  const notice = await waitFor(() => {
    const n = document.querySelector(".notice");
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  expect(within(notice).getByText(/reached the guest message limit/i)).toBeTruthy();
  expect(within(notice).getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(box.disabled).toBe(true); // no silent refusal, and the input is disabled while the dialog is up
});
