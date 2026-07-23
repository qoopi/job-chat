// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";

// A turn that errors at the SDK level streams NO data-error part, so MessageList
// has nothing to render from the message parts. The client surfaces the error from useChat's error state
// too (a `liveError` flag), rendering the same ErrorCard + Retry. Two guards ride with it: never
// double-render when a data-error part ALSO exists (tool failures stream the part), and Retry only on the
// TAIL error card - regenerate() re-answers the tail, so a mid-thread error card offers no Retry.
vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

import { MessageList } from "@/components/chat/MessageList";

const noop = () => {};
const noSet = new Set<string>();
const base = { pending: false, usedFollowups: noSet, onFollowup: noop, onOpenDetailPanel: noop };

const userMsg = (text: string, id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const errorMsg = (id: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "data-error", id: `${id}-e`, data: { kind: "system" } }],
});
const insight: DataInsight = {
  id: "card",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads.",
  series: [{ company: "Amazon", count: 214 }],
  followups: [],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};
const insightMsg = (id: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "data-insight", id: `${id}-c0`, data: insight }],
});

afterEach(cleanup);

describe("MessageList live error affordance (AC-7 live, SDK-synthesis path)", () => {
  test("Should_ShowLiveErrorCardWithRetry_When_useChatErrors", () => {
    const onRetry = vi.fn();
    const { container } = render(
      <MessageList messages={[userMsg("Who is hiring?", "u1")]} onRetry={onRetry} liveError {...base} />,
    );
    // No data-error part streamed for this class, but the live error state surfaces the card at the tail.
    expect(container.querySelector(".err-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("does NOT double-render when a data-error part already streamed (both signals present)", () => {
    const { container } = render(
      <MessageList messages={[userMsg("Q", "u1"), errorMsg("a1")]} onRetry={noop} liveError {...base} />,
    );
    // Exactly ONE error card - the streamed one - even though useChat also reports the error.
    expect(container.querySelectorAll(".err-card").length).toBe(1);
  });

  test("no live error card when useChat is not in an error state (answered tail)", () => {
    // Tail is an ANSWERED assistant turn - so neither the live-error card nor the settled failed-tail Retry
    // card fires. (A settled UNANSWERED user tail now surfaces its own failed-turn card - covered in
    // message-list.test.tsx's reload-after-failure suite.)
    const { container } = render(
      <MessageList messages={[userMsg("Q", "u1"), insightMsg("a1")]} onRetry={noop} liveError={false} {...base} />,
    );
    expect(container.querySelector(".err-card")).toBeNull();
  });
});

describe("MessageList error-card Retry is tail-only (regenerate re-answers the tail)", () => {
  test("a TAIL error card offers Retry", () => {
    const onRetry = vi.fn();
    render(<MessageList messages={[userMsg("Q", "u1"), errorMsg("a1")]} onRetry={onRetry} {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("a MID-THREAD error card (a later turn exists after it) renders WITHOUT Retry", () => {
    const { container } = render(
      <MessageList
        messages={[userMsg("Q1", "u1"), errorMsg("a1"), userMsg("Q2", "u2"), insightMsg("a2")]}
        onRetry={noop}
        {...base}
      />,
    );
    // The error card still renders (the turn's outcome), but its Retry is gone - regenerate would
    // re-answer the TAIL (a2), not this mid-thread turn.
    expect(container.querySelector(".err-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
