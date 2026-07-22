// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DataInsight } from "@shared/insight";

// Render-count probe: toggling "Show query" flips only sqlOpen, so the Recharts subtree must NOT
// re-render. We stub InsightChart with a render counter; InsightCard memoizes the chart element keyed
// on the insight, so React reuses the same element and bails out of re-rendering it. Without that
// memo the chart element is recreated on every card render and this counter would climb past 1.
const probe = vi.hoisted(() => ({ chartRenders: 0 }));
vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => {
    probe.chartRenders++;
    return <div data-testid="chart-subtree" />;
  },
}));

import { InsightCard } from "@/components/insight/InsightCard";

const chartInsight: DataInsight = {
  id: "memo-probe",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles.",
  series: [
    { company: "Amazon", count: 214 },
    { company: "Databricks", count: 121 },
  ],
  followups: [],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};

afterEach(() => {
  cleanup();
  probe.chartRenders = 0;
});

test("Should_NotReRenderChartSubtree_When_ShowQueryToggled", () => {
  render(<InsightCard insight={chartInsight} />);
  expect(probe.chartRenders).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Show query" }));
  expect(screen.getByRole("button", { name: "Hide query" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide query" }));

  // sqlOpen toggled on and off; the memoized chart element was reused both times.
  expect(probe.chartRenders).toBe(1);
});

// Regression guard: MessageList hands InsightCard a STABLE `onOpenLcp` plus stable message/part
// ids and flips `pending` at each turn boundary, so a SETTLED card re-renders whenever a later turn
// starts/ends. The chart-subtree memo must survive that: because the open-table callback is now stable
// on `[onOpenLcp, messageId, partId]` (all ref-stable across a turn), no ref hack is needed and the
// Recharts element is not recomputed. We reuse the same onOpenLcp/ids across re-renders, as MessageList
// does, and flip `pending` - the counter must stay at 1.
test("Should_NotReRenderChartSubtree_When_PendingFlipsWithStableCallback", () => {
  const onOpenLcp = () => {};
  const { rerender } = render(
    <InsightCard insight={chartInsight} onOpenLcp={onOpenLcp} messageId="m" partId="p" pending={false} />,
  );
  expect(probe.chartRenders).toBe(1);

  // a later turn begins: pending -> true (the stable ids/callback are unchanged)
  rerender(
    <InsightCard insight={chartInsight} onOpenLcp={onOpenLcp} messageId="m" partId="p" pending={true} />,
  );
  // ...and settles: pending -> false
  rerender(
    <InsightCard insight={chartInsight} onOpenLcp={onOpenLcp} messageId="m" partId="p" pending={false} />,
  );

  // the settled card's chart subtree was memoized across both turn-boundary re-renders
  expect(probe.chartRenders).toBe(1);
});
