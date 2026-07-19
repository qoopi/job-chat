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
