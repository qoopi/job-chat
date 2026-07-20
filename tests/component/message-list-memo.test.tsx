// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";

// P2 render-count probe (companion to insight-card-memo): a SETTLED assistant turn must NOT re-render
// when a later turn streams in. `useChat` fires a messages-changed callback per data-* delta and
// MessageList re-maps the whole thread each time; without memoizing the per-message component, every
// prior InsightCard (Recharts, heavy) re-renders on every streamed chunk. We stub InsightCard with a
// per-insight render counter; `React.memo(AssistantMessage)` bails on the settled turn (its message
// ref + used Set + callbacks are all stable) so its counter stays at 1 across the streaming re-render.
// Without the memo the settled card re-renders with the parent and the counter climbs to 2.
const probe = vi.hoisted(() => ({ byId: new Map<string, number>() }));
vi.mock("@/components/insight/InsightCard", () => ({
  InsightCard: ({ insight }: { insight: DataInsight }) => {
    probe.byId.set(insight.id, (probe.byId.get(insight.id) ?? 0) + 1);
    return <div data-testid={`card-${insight.id}`} />;
  },
}));

import { MessageList } from "@/components/chat/MessageList";

function insight(id: string, verdict: string): DataInsight {
  return {
    id,
    kind: "chart",
    chartType: "bars",
    verdict,
    series: [{ company: "Amazon", count: 214 }],
    followups: ["Only remote roles"],
    meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
  };
}

// Stable prop refs, exactly as ChatClient now supplies them (used Set unchanged mid-stream, onFollowup
// / onRetry useCallback-stable). Reusing the same objects across the re-render is what lets memo bail.
const usedFollowups = new Set<string>();
const noop = () => {};
const userTurn: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] };
const settled: UIMessage = {
  id: "a1",
  role: "assistant",
  parts: [{ type: "data-insight", id: "a1-c0", data: insight("settled-card", "Amazon leads hiring with 214 open roles.") }],
};

afterEach(() => {
  cleanup();
  probe.byId.clear();
});

test("Should_NotReRenderSettledInsightCard_When_LaterTurnStreams", () => {
  const first: UIMessage[] = [userTurn, settled];
  const { rerender } = render(
    <MessageList messages={first} pending={true} usedFollowups={usedFollowups} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
  );
  expect(probe.byId.get("settled-card")).toBe(1);

  // A new turn streams in. The settled message keeps its object ref (the SDK preserves settled refs via
  // slice; here we pass the identical object), so React.memo must skip re-rendering the settled card.
  const streaming: UIMessage = {
    id: "a2",
    role: "assistant",
    parts: [{ type: "data-insight", id: "a2-c0", data: insight("streaming-card", "Stripe leads next quarter with 99 open roles.") }],
  };
  const second: UIMessage[] = [
    userTurn,
    settled,
    { id: "u2", role: "user", parts: [{ type: "text", text: "next" }] },
    streaming,
  ];
  rerender(
    <MessageList messages={second} pending={true} usedFollowups={usedFollowups} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
  );

  // The settled card did NOT re-render (memo bailed); only the freshly streamed card rendered.
  expect(probe.byId.get("settled-card")).toBe(1);
  expect(probe.byId.get("streaming-card")).toBe(1);
});

// Companion perf probe for the USER bubble. Bubble's wrap-measure effect calls getComputedStyle (a
// synchronous forced reflow) every time it re-renders. User bubbles are memoized on their message ref
// (UserBubble), so a settled user turn must NOT re-measure when a later turn streams. We spy on
// getComputedStyle and assert only the NEW user bubble measures on the streaming re-render. Without the
// UserBubble memo the settled bubble re-renders with the parent and re-measures, so the count is 2.
test("Should_NotReMeasureSettledUserBubble_When_LaterTurnStreams", () => {
  const gcs = vi.spyOn(window, "getComputedStyle");
  // settled is a data-insight card (no Bubble), so the lone user turn is the only bubble that measures.
  const first: UIMessage[] = [userTurn, settled];
  const { rerender } = render(
    <MessageList messages={first} pending={true} usedFollowups={usedFollowups} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
  );
  gcs.mockClear(); // ignore the mount-time measurement of the settled user bubble

  const streaming: UIMessage = {
    id: "a2",
    role: "assistant",
    parts: [{ type: "data-insight", id: "a2-c0", data: insight("streaming-card-2", "Stripe leads next quarter.") }],
  };
  const second: UIMessage[] = [
    userTurn, // same ref -> UserBubble memo bails, no re-measure
    settled,
    { id: "u2", role: "user", parts: [{ type: "text", text: "next" }] },
    streaming,
  ];
  rerender(
    <MessageList messages={second} pending={true} usedFollowups={usedFollowups} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
  );

  // Only the freshly-mounted u2 bubble measured; the settled user bubble did not re-run its reflow.
  expect(gcs).toHaveBeenCalledTimes(1);
  gcs.mockRestore();
});
