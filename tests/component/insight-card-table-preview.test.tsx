// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DataInsight } from "@shared/insight";

// AC-8 (preview slice) + Ruling 27 (2026-07-21): the >8-row preview->LCP rule applies to EVERY table
// view - a table insight AND a chart card's Table tab. Over the 8-row threshold renders a 5-row preview
// plus an "Open full table (N rows)" affordance; at/under the threshold renders every row inline with no
// affordance. The Recharts subtree is stubbed - this test is about the table body, not the chart.
vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

import { InsightCard } from "@/components/insight/InsightCard";

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

const bodyRows = (c: HTMLElement) => c.querySelectorAll("tbody tr").length;

afterEach(cleanup);

describe("InsightCard table preview (AC-8)", () => {
  test("Should_PreviewAndAfford_When_TableExceedsThreshold", () => {
    const onOpenTable = vi.fn();
    const { container } = render(<InsightCard insight={tableInsight(9)} onOpenTable={onOpenTable} />);

    // Only the first 5 of the 9 rows render in the preview card.
    expect(bodyRows(container)).toBe(5);

    const affordance = screen.getByRole("button", { name: "Open full table (9 rows)" });
    fireEvent.click(affordance);
    expect(onOpenTable).toHaveBeenCalledOnce();
  });

  test("Should_RenderFullInline_When_TableAtThreshold", () => {
    const { container } = render(<InsightCard insight={tableInsight(8)} />);
    expect(bodyRows(container)).toBe(8);
    expect(screen.queryByRole("button", { name: /Open full table/ })).toBeNull();
  });

  function chartInsight(n: number): DataInsight {
    return {
      id: "c1",
      kind: "chart",
      chartType: "bars",
      verdict: "Amazon leads hiring with 214 open roles.",
      series: Array.from({ length: n }, (_, i) => ({ company: `Co ${i + 1}`, count: 100 - i })),
      followups: [],
      meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
    };
  }

  test("Ruling 27: Should_PreviewAndOpenLcp_When_ChartTableTabExceedsThreshold", () => {
    const onOpenTable = vi.fn();
    const { container } = render(<InsightCard insight={chartInsight(12)} onOpenTable={onOpenTable} />);
    // Chart tab shows the chart, no table preview.
    expect(screen.getByTestId("chart-subtree")).toBeTruthy();

    // Switch to the Table tab: the same >8-row rule applies - only 5 rows preview + the affordance.
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    expect(bodyRows(container)).toBe(5);
    const affordance = screen.getByRole("button", { name: "Open full table (12 rows)" });
    fireEvent.click(affordance);
    expect(onOpenTable).toHaveBeenCalledOnce();
  });

  test("Ruling 27: a chart's Table tab at/under the threshold renders every row inline", () => {
    const { container } = render(<InsightCard insight={chartInsight(8)} />);
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    expect(bodyRows(container)).toBe(8);
    expect(screen.queryByRole("button", { name: /Open full table/ })).toBeNull();
  });
});
