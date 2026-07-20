// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { Conversation } from "@shared/store";
import type { DataInsight } from "@shared/insight";

// AC-19: New chat starts fresh IN PLACE (clear thread, close LCP, focus composer, no bounce to the
// landing); the first message afterwards starts a brand-new conversation (the landing handoff). AC-21:
// deleting the OPEN conversation clears to that same fresh-chat state. Driven through the REAL ChatClient;
// the transport + server actions are external boundaries and mocked exactly as the sibling ChatClient tests.
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
const deleteConversationMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (id: string, t: string) => sendMessageMock(id, t),
  mintChatToken: vi.fn(),
  startConversation: (t: string) => startConversationMock(t),
  deleteConversation: (id: string) => deleteConversationMock(id),
  listMyConversations: vi.fn(async () => []),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

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
const thread: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
  { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: tableInsight(9) }] },
];
const convs: Pick<Conversation, "id" | "title" | "created_at">[] = [
  { id: CONVERSATION_ID, title: "Top companies today", created_at: new Date() },
];
const composer = () => screen.getByRole("textbox", { name: "Ask a follow-up" }) as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  startConversationMock.mockReset();
  deleteConversationMock.mockReset();
  pushMock.mockReset();
});

describe("New chat in place (AC-19)", () => {
  test("Should_StartFreshChatInPlace_When_NewChatFromChatView: thread cleared, LCP closed, composer focused, no nav to /", async () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        title="Top companies today"
        initialMessages={thread}
        signedIn
        conversations={convs}
        e2e={false}
      />,
    );

    // Open the LCP first, so we can prove New chat closes it.
    fireEvent.click(await screen.findByRole("button", { name: "Open full table (9 rows)" }));
    expect(document.querySelector(".lcp")).toBeTruthy();
    expect(screen.getByText("Top companies?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    // Fresh in place: thread cleared, LCP closed (canvas un-docked), composer focused, and NO navigation.
    expect(screen.queryByText("Top companies?")).toBeNull();
    expect(document.querySelector(".lcp")).toBeNull();
    expect(document.querySelector(".canvas.docked")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(composer()));
    expect(pushMock).not.toHaveBeenCalled(); // never a bounce to "/"
  });

  test("the first message after New chat starts a NEW conversation and soft-navigates to it (landing handoff)", async () => {
    const NEW_ID = "22222222-2222-4222-8222-222222222222";
    startConversationMock.mockResolvedValue({ ok: true, conversationId: NEW_ID });
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={[]} signedIn conversations={convs} e2e={false} />);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    const box = composer();
    fireEvent.change(box, { target: { value: "Median salary in NYC" } });
    fireEvent.keyDown(box, { key: "Enter" });

    // The fresh first message creates a conversation (NOT a follow-up on the reset thread) and pushes to it.
    await waitFor(() => expect(startConversationMock).toHaveBeenCalledWith("Median salary in NYC"));
    expect(sendMessageMock).not.toHaveBeenCalled(); // not a follow-up
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/chat/${NEW_ID}?new=1`));
  });
});

describe("delete the open conversation (AC-21)", () => {
  test("deleting the OPEN conversation removes the row and clears to the fresh-chat state", async () => {
    deleteConversationMock.mockResolvedValue({ ok: true });
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        title="Top companies today"
        initialMessages={thread}
        signedIn
        conversations={convs}
        e2e={false}
      />,
    );
    expect(screen.getByText("Top companies?")).toBeTruthy(); // the open thread renders

    // Inline confirm -> Delete. The affordance name carries a short id suffix; match the title prefix.
    fireEvent.click(screen.getByRole("button", { name: /^Delete Top companies today/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteConversationMock).toHaveBeenCalledWith(CONVERSATION_ID));
    // The row is dropped from the history list AND, because it was the open one, the thread clears.
    await waitFor(() => expect(screen.queryByText("Top companies today")).toBeNull());
    expect(screen.queryByText("Top companies?")).toBeNull();
    expect(pushMock).not.toHaveBeenCalled(); // cleared in place, not navigated
  });
});
