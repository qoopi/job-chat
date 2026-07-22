// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DataInsight } from "@shared/insight";

// The source line ("N postings - updated ...") must be suppressed entirely
// when sampleN is 0, so a defensive empty card can never show "0 postings - updated 20654d ago" (the
// epoch-freshness bug). The Recharts subtree is stubbed - this test is about the foot source line only.
vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

import { InsightCard } from "@/components/insight/InsightCard";

function insightWith(
  sampleN: number,
  updatedAt: string,
  openSet?: boolean,
): DataInsight {
  return {
    id: "src-line",
    kind: "chart",
    chartType: "histogram",
    verdict: "The median salary is 180000 here.",
    series: [{ bucket: 160000, count: 3, median: 180000 }],
    followups: [],
    meta: {
      sql: "SELECT 1",
      sampleN,
      updatedAt,
      ...(openSet ? { openSet: true } : {}),
    },
  };
}

afterEach(cleanup);

describe("InsightCard source line", () => {
  test("shows the postings count and Show query when sampleN > 0", () => {
    render(<InsightCard insight={insightWith(412, "2026-07-18 19:12:00")} />);
    expect(screen.getByText(/412 postings/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show query" })).toBeTruthy();
  });

  test("suppresses the whole source line when sampleN is 0 (no epoch freshness)", () => {
    render(<InsightCard insight={insightWith(0, "1970-01-01 00:00:00")} />);
    expect(screen.queryByText(/postings/)).toBeNull();
    expect(screen.queryByText(/updated/)).toBeNull();
    expect(screen.queryByText(/ago/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show query" })).toBeNull();
  });
});

// A current-state read (open-set predicate applied) reads "N open postings"; a full-history read
// keeps the plain "N postings"; the sampleN=0 suppression is unchanged either way.
describe("InsightCard open-set source-line copy", () => {
  test("reads 'N open postings' when meta.openSet is set", () => {
    render(
      <InsightCard insight={insightWith(412, "2026-07-18 19:12:00", true)} />,
    );
    expect(screen.getByText(/412 open postings/)).toBeTruthy();
  });

  test("reads plain 'N postings' when meta.openSet is absent", () => {
    render(<InsightCard insight={insightWith(412, "2026-07-18 19:12:00")} />);
    expect(screen.getByText(/412 postings/)).toBeTruthy();
    expect(screen.queryByText(/open postings/)).toBeNull();
  });

  test("suppresses the source line entirely when sampleN is 0 even with openSet set", () => {
    render(
      <InsightCard insight={insightWith(0, "1970-01-01 00:00:00", true)} />,
    );
    expect(screen.queryByText(/postings/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show query" })).toBeNull();
  });
});

// A capped bars chart's source line discloses "showing top 8" beside the real
// total, and only on the chart view (the Table tab shows every row via preview -> LCP). The Recharts
// subtree is stubbed so the source-line text is what is under test.
describe("InsightCard capped-chart source line", () => {
  function barsInsight(n: number): DataInsight {
    return {
      id: "bars",
      kind: "chart",
      chartType: "bars",
      verdict: "Amazon leads the top 8 titles with 11 openings.",
      series: Array.from({ length: n }, (_, i) => ({
        title: `Role ${i + 1}`,
        count: 100 - i,
      })),
      followups: [],
      meta: {
        sql: "SELECT 1",
        sampleN: 1863,
        updatedAt: "2026-07-18 19:12:00",
        openSet: true,
      },
    };
  }

  test("shows the real total AND 'showing top 8' on the chart view when the bars cap", () => {
    render(<InsightCard insight={barsInsight(20)} />);
    expect(screen.getByText(/1,863 open postings/)).toBeTruthy(); // the real denominator, not the slice
    expect(screen.getByText(/showing top 8/)).toBeTruthy();
  });

  test("no 'showing top' suffix when the series is at/under the cap", () => {
    render(<InsightCard insight={barsInsight(6)} />);
    expect(screen.queryByText(/showing top/)).toBeNull();
  });

  test("drops 'showing top' on the Table tab (that view shows every row, not a top-N slice)", () => {
    render(<InsightCard insight={barsInsight(20)} />);
    expect(screen.getByText(/showing top 8/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    expect(screen.queryByText(/showing top/)).toBeNull();
  });
});
