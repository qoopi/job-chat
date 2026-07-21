// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DataInsight } from "@shared/insight";

// P2 render-count probe: toggling "Show query" flips only sqlOpen, so the Recharts subtree must NOT
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

// Ruling s2 regression guard (fix round): MessageList hands InsightCard a FRESH inline `onOpenTable`
// (`() => onOpenLcp(message.id, id)`) on every render AND flips `pending` at each turn boundary, so a
// SETTLED card re-renders whenever a later turn starts/ends. The chart-subtree memo must survive that -
// a ref-unstable onOpenTable must NOT recompute the Recharts element. We keep the insight ref stable (a
// settled card) but pass a new onOpenTable closure and flip `pending` on each rerender, exactly as
// MessageList does. Before the fix the chartEl memo depended on onOpenTable, so its counter climbed.
test("Should_NotReRenderChartSubtree_When_PendingFlipsWithFreshCallback", () => {
  const { rerender } = render(
    <InsightCard insight={chartInsight} onOpenTable={() => {}} pending={false} />,
  );
  expect(probe.chartRenders).toBe(1);

  // a later turn begins: pending -> true, and MessageList re-creates the inline callback (new ref)
  rerender(
    <InsightCard insight={chartInsight} onOpenTable={() => {}} pending={true} />,
  );
  // ...and settles: pending -> false, the callback ref changes again
  rerender(
    <InsightCard insight={chartInsight} onOpenTable={() => {}} pending={false} />,
  );

  // the settled card's chart subtree was memoized across both turn-boundary re-renders
  expect(probe.chartRenders).toBe(1);
});
