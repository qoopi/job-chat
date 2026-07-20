// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";
import { closeAuthDialog } from "@/lib/auth-dialog";
import { setAuthDialogOpen } from "@/lib/layers";

// AC-10: the lazy auth dialog opens on a Sign-in tap AND at the guest cap moment, and every dismiss
// (cancel / Esc / backdrop) returns to the chat untouched. AC-9 (partial): with the REAL dialog above an
// open LCP, Esc closes the dialog only and leaves the LCP (this supersedes 011's forced-flag stub as the
// integration truth - interaction-spec "Priority of layers"). All external boundaries are mocked exactly
// as chat-client.test.tsx does; here no turn streams, so the transport is inert.
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

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: vi.fn(), social: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    useSession: () => ({ data: null, isPending: false }),
  },
}));

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
});
