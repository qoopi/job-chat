// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";

// Regression for the operator's live-stream replay artifact (006, paired-screenshot evidence): DURING a
// follow-up's live stream the NEW assistant answer renders prefixed with the PREVIOUS turn's prose and
// re-shows the previous card; a page refresh renders the same conversation correctly (store truth clean).
//
// Root cause, verified in the SDK source (node_modules/@trigger.dev/sdk, 4.5.4):
//   - `TriggerChatTransport.sendMessages` subscribes via `subscribeToSessionStream`, which opens the
//     `.out` SSE with `lastEventId: state.lastEventId` (chat.js ~L1025). `sinceInSeq` only filters stale
//     turn-complete CONTROL records - data chunks enqueue unconditionally (~L1209).
//   - `setSession` REPLACES the cached session (chat.js ~L643); calling it without `lastEventId` WIPES
//     the tracked cursor, so the follow-up `.out` subscribe replays the session log from the START.
//   - The AI SDK's `processUIMessageStream` keeps ONE `state.message`; a `start` chunk only overwrites
//     `state.message.id` and every part chunk pushes into the same `state.message.parts` (ai/dist ~L7035).
//     So a replayed prior turn cannot be reconciled by id client-side - its prose and card ACCUMULATE
//     into the new turn's single message.
//
// The fix threads the prior turn's `lastEventId` back into `setSession` at send time, so the `.out`
// subscribe resumes AFTER the prior turn and only the new turn's chunks arrive. This drives that exact
// flow through the real `useChat` merge against the shipped `MockChatTransport` (extended to re-deliver
// the prior tail when uncursored, exactly as the real transport does):
//   - Pre-fix: the follow-up's `setSession` wipes the cursor -> the mock prepends the prior turn -> the
//     new answer accumulates the old prose + the old card re-appears (RED).
//   - Post-fix: the follow-up threads the prior turn's cursor -> only the new turn streams (GREEN).

vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

// The real, shipped MockChatTransport - one instance for the whole test so its session cache (the
// cursor the fix must preserve) survives across ChatClient's setSession/sendMessages calls.
const transport = await vi.hoisted(async () => {
  const { MockChatTransport } = await import("@/lib/mock-transport");
  return new MockChatTransport();
});
vi.mock("@/lib/chat-transport", () => ({ useJobChatTransport: () => transport }));

const sendMessageMock = vi.fn();
const mintChatTokenMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (conversationId: string, text: string) => sendMessageMock(conversationId, text),
  mintChatToken: (conversationId: string) => mintChatTokenMock(conversationId),
}));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const PRIOR_ID = "prior-assistant-1";
const OLD_PROSE = "OLD PROSE FROM THE PREVIOUS TURN";
const NEW_ANSWER = "FRESH ANSWER FOR THIS TURN";

const card: DataInsight = {
  id: "card-prior",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles.",
  series: [{ company: "Amazon", count: 214 }],
  followups: ["Only remote roles"],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};

// The conversation after turn 1, as the store hydrates it: one Q + one answered turn (prose + card).
const hydrated: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
  {
    id: PRIOR_ID,
    role: "assistant",
    parts: [
      { type: "text", text: OLD_PROSE },
      { type: "data-insight", id: `${PRIOR_ID}-card-0`, data: card },
    ],
  },
];

afterEach(() => {
  cleanup();
  sendMessageMock.mockReset();
  mintChatTokenMock.mockReset();
  delete window.__CHAT_SCRIPT__;
  delete window.__CHAT_PRIOR_TAIL__;
});

test("a follow-up streams ONLY the new turn - the previous turn's prose/card never leak into the new answer", async () => {
  sendMessageMock.mockResolvedValue({ ok: true, publicAccessToken: "tok-followup" });

  // Turn 1 has already streamed live, so the transport tracks its final `.out` cursor. (In production
  // the transport advances `state.lastEventId` as it streams; here we seed the equivalent end state.)
  transport.setSession(CONVERSATION_ID, {
    publicAccessToken: "tok-prior",
    isStreaming: false,
    lastEventId: "evt-prior-turn-last",
  });

  // What the server re-delivers when the follow-up subscribe opens with NO cursor: turn 1's `.out`
  // chunks (its prose + its card), under turn 1's own message id.
  window.__CHAT_PRIOR_TAIL__ = [
    { chunk: { type: "start", messageId: PRIOR_ID } },
    { chunk: { type: "text-start", id: "op" } },
    { chunk: { type: "text-delta", id: "op", delta: OLD_PROSE } },
    { chunk: { type: "text-end", id: "op" } },
    { chunk: { type: "data-insight", id: `${PRIOR_ID}-card-0`, data: card } },
    { chunk: { type: "finish" } },
  ];

  // The fresh turn's own chunks.
  window.__CHAT_SCRIPT__ = [
    { chunk: { type: "start", messageId: "fresh-assistant-2" } },
    { chunk: { type: "text-start", id: "np" } },
    { chunk: { type: "text-delta", id: "np", delta: NEW_ANSWER } },
    { chunk: { type: "text-end", id: "np" } },
    { chunk: { type: "finish" } },
  ];

  render(<ChatClient conversationId={CONVERSATION_ID} initialMessages={hydrated} e2e={false} />);

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "And their remote roles?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByText("And their remote roles?"); // optimistic user bubble

  // The fresh answer streams. Pre-fix its bubble also carries the accumulated OLD_PROSE prefix.
  const freshBubble = await screen.findByText(new RegExp(NEW_ANSWER));

  // The new answer must contain ONLY the new turn's prose - no prior-turn prose folded in front of it.
  expect(freshBubble.textContent).not.toContain(OLD_PROSE);

  // The previous turn's card must render exactly once (the hydrated one), never re-shown inside the
  // new turn's accumulated message.
  expect(document.querySelectorAll(".verdict").length).toBe(1);
});
