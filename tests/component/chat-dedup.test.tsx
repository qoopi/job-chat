// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";

// Regression for the operator's live-walk duplicate-key error ("Encountered two children with the same
// key" at MessageList, AssistantMessage key={m.id}). Root cause, verified at source: an existing
// conversation is hydrated into `useChat` from the store (storeToUiMessages -> initialMessages), then a
// follow-up send delivers + watches via the transport's `sendMessages`. That
// subscribe opens `.out` with no `lastEventId` cursor (the server-rendered page has none), so the server
// replays the session's `.out` tail from the start - re-emitting the ALREADY-HYDRATED assistant turn
// under its original id. The AI SDK's write then `pushMessage`s that replayed turn (its id != the
// just-appended user turn's id), so a turn that is already in the list lands a SECOND time under the same
// id -> duplicate React key, and the old card visibly re-appears. This drives that exact flow through the
// real `useChat` merge (the mock transport's `sendMessages` replays the tail, as the real one does when
// resuming from the start) and asserts the hydrated card renders EXACTLY ONCE.

vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

// The real, shipped MockChatTransport (extended with the `__CHAT_REPLAY__` tail) - not an inline stub -
// so the reconnect/replay path under test is the one the e2e suite ships.
vi.mock("@/lib/chat-transport", async () => {
  const { MockChatTransport } = await import("../e2e/mock-transport");
  const instance = new MockChatTransport();
  return { useJobChatTransport: () => instance };
});

const sendMessageMock = vi.fn();
const mintChatTokenMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (conversationId: string, text: string) => sendMessageMock(conversationId, text),
  mintChatToken: (conversationId: string) => mintChatTokenMock(conversationId),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const ASSISTANT_ID = "EKzSTGN9VNktoFTr"; // a realistic SDK-shaped id

const insight: DataInsight = {
  id: "card-x",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles.",
  series: [{ company: "Amazon", count: 214 }],
  followups: ["Only remote roles"],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};

// An existing conversation as the store hydrates it: one Q + one answered card.
const hydrated: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
  { id: ASSISTANT_ID, role: "assistant", parts: [{ type: "data-insight", id: `${ASSISTANT_ID}-card-0`, data: insight }] },
];

afterEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  mintChatTokenMock.mockReset();
  delete window.__CHAT_SCRIPT__;
});

test("a follow-up that replays the hydrated tail renders the existing card exactly once (no duplicate key)", async () => {
  sendMessageMock.mockResolvedValue({ ok: true });

  // The follow-up's `sendMessages` subscribe replays the session `.out` tail from the start: the SAME
  // assistant turn (id = ASSISTANT_ID) that is already hydrated, plus a marker text so the test can await
  // the replay having been fully processed.
  // The replayed card turn carries NO prose (a card is the whole answer - model prose is
  // suppressed), so a trailing text marker on it would not render. Instead the replay re-emits the card
  // with a DISTINCT verdict; reconcile replaces the hydrated turn in place, so waiting for that verdict
  // to appear confirms the replay was fully consumed - and the count then proves it landed exactly once.
  const replayedInsight: DataInsight = { ...insight, verdict: "Amazon leads hiring with 214 replayed roles." };
  window.__CHAT_SCRIPT__ = [
    { chunk: { type: "start", messageId: ASSISTANT_ID } },
    { chunk: { type: "data-insight", id: `${ASSISTANT_ID}-card-0`, data: replayedInsight } },
    { chunk: { type: "finish" } },
  ];

  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={hydrated} e2e={false} />);

    const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
    fireEvent.change(box, { target: { value: "Only remote roles" } });
    fireEvent.keyDown(box, { key: "Enter" });

    // Wait until the replay has been fully consumed (the card's verdict updates to the replayed one).
    await screen.findByText(/replayed roles/);

    // The hydrated turn must render exactly once - not a second re-appended copy under the same key.
    expect(document.querySelectorAll(".verdict").length).toBe(1);

    const dupKeyWarning = errSpy.mock.calls.some((c) =>
      /same key|two children/i.test(c.map((a) => String(a)).join(" ")),
    );
    expect(dupKeyWarning).toBe(false);
  } finally {
    errSpy.mockRestore();
  }
});
