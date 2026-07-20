// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";
import { closeAuthDialog } from "@/lib/auth-dialog";
import { setAuthDialogOpen } from "@/lib/layers";

// 017: Google-ONLY sign-in (email/password removed). The lazy auth dialog opens on a Sign-in tap AND at
// the guest cap moment, offers ONLY "Continue with Google", and every dismiss (cancel / Esc / backdrop)
// returns to the chat untouched. AC-9 (partial): with the REAL dialog above an open LCP, Esc closes the
// dialog only and leaves the LCP (interaction-spec "Priority of layers"). External boundaries mocked as
// chat-client.test.tsx does; here no turn streams, so the transport is inert.
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
  listMyConversations: vi.fn(async () => []),
  clearGuestSession: vi.fn(async () => {}),
}));

const signInSocialMock = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { social: (a: unknown) => signInSocialMock(a) },
    signOut: vi.fn(),
    useSession: () => ({ data: null, isPending: false }),
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

const composer = () => screen.getByRole("textbox", { name: "Ask a follow-up" }) as HTMLTextAreaElement;
const pressEsc = () => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
const clickSidebarSignIn = () => fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[0]);

function tableInsight(n: number): DataInsight {
  return {
    id: "t1",
    kind: "table",
    verdict: "Amazon leads hiring across the market.",
    rows: Array.from({ length: n }, (_, i) => ({ company: `Co ${i + 1}`, count: 100 - i })),
    followups: [],
    meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
  };
}
function threadWithTable(n: number): UIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
    { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: tableInsight(n) }] },
  ];
}

afterEach(() => {
  cleanup();
  closeAuthDialog();
  setAuthDialogOpen(false);
  sendMessageMock.mockReset();
  signInSocialMock.mockReset();
  window.history.replaceState(null, "", "/");
});

describe("google-only auth dialog (017)", () => {
  test("Should_OfferOnlyGoogle_When_Opened", () => {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
    clickSidebarSignIn();

    expect(screen.getByRole("dialog", { name: "Sign in to jobchat.dev" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeTruthy();
    // no email/password affordances remain
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });

  test("Should_StartClientGoogleRedirect_When_ContinueTapped", () => {
    render(<AuthDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue with Google/i }));
    expect(signInSocialMock).toHaveBeenCalledTimes(1);
    expect(signInSocialMock.mock.calls[0][0]).toMatchObject({ provider: "google" });
  });
});

describe("auth dialog open (AC-10)", () => {
  test("Should_OpenAuthDialog_When_SignInTapped", () => {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    clickSidebarSignIn();

    expect(screen.getByRole("dialog", { name: "Sign in to jobchat.dev" })).toBeTruthy();
    // the composer dims while the dialog is up (interaction-spec section 4)
    expect(composer().disabled).toBe(true);
  });

  test("Should_OpenAuthDialog_When_GuestCapHit", async () => {
    sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);

    const box = composer();
    fireEvent.change(box, { target: { value: "One more question" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(await screen.findByRole("dialog", { name: "Sign in to jobchat.dev" })).toBeTruthy();
  });
});

describe("auth dialog dismiss returns to chat untouched (AC-10)", () => {
  const initial: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "A prior question" }] }];

  test.each([
    ["cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Esc", () => pressEsc()],
    ["backdrop", () => fireEvent.click(document.querySelector(".overlay") as HTMLElement)],
  ])("Should_ReturnToChatUntouched_OnEachDismiss: %s", (_label, dismiss) => {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={initial} e2e={false} />);
    clickSidebarSignIn();
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => void dismiss());

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().disabled).toBe(false); // composer re-enabled
    expect(screen.getByText("A prior question")).toBeTruthy(); // thread intact
  });
});

describe("Esc layer priority: real dialog above the LCP (AC-9)", () => {
  test("Should_RouteEscToAuthDialog_WhenRealDialogAboveLcp", async () => {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={threadWithTable(9)} e2e={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open full table (9 rows)" }));
    expect(document.querySelector(".lcp")).toBeTruthy();

    // open the REAL dialog on top of the open LCP
    clickSidebarSignIn();
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Esc closes the dialog ONLY - the LCP (below it) stays open
    pressEsc();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".lcp")).toBeTruthy();

    // with the dialog gone, Esc now closes the LCP
    pressEsc();
    expect(document.querySelector(".lcp")).toBeNull();
  });

  test("Should_NotDisturbLowerLayer_When_DialogEscHandlerRegisteredFirst", () => {
    // Order-independence (should-fix 1): register the dialog's Esc listener BEFORE a lower-layer window
    // handler - the REVERSE of the app's natural mount order (where the LCP binds first). Even so, the
    // dialog's `stopImmediatePropagation` suppresses the lower handler, so a single Esc never falls
    // through the dialog to the layer beneath it, whichever listener happens to be registered first.
    const onClose = vi.fn();
    const lowerLayer = vi.fn();
    render(<AuthDialog onClose={onClose} />);
    window.addEventListener("keydown", lowerLayer); // registered AFTER -> the dialog's listener runs first
    try {
      pressEsc();
    } finally {
      window.removeEventListener("keydown", lowerLayer);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lowerLayer).not.toHaveBeenCalled(); // suppressed even though the dialog's handler ran first
  });
});

describe("modal focus a11y (AC-10)", () => {
  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

  test("Should_FocusIntoDialog_When_Opened", () => {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
    clickSidebarSignIn();
    const dialog = screen.getByRole("dialog");
    // focus moved off the background shell and into the dialog (the Google button) on open
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).id).toBe("auth-google");
  });

  test("Should_ContainTab_When_TabbingPastDialogEdges", () => {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
    clickSidebarSignIn();
    const dialog = screen.getByRole("dialog");
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    expect(focusables.length).toBeGreaterThan(1);

    // Tab off the last focusable wraps to the first (focus never leaves the dialog)
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Shift+Tab off the first wraps back to the last
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test("Should_RestoreFocusToOpener_When_DialogCloses", () => {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} e2e={false} />);
    const opener = screen.getAllByRole("button", { name: "Sign in" })[0];
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).not.toBe(opener); // focus moved INTO the dialog on open

    pressEsc(); // close via Esc
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener); // focus returned to the trigger, not lost to <body>
  });
});
