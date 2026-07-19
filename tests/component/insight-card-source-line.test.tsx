// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DataInsight } from "@shared/insight";

// P1 polish (must-fix #2): the source line ("N postings - updated ...") must be suppressed entirely
// when sampleN is 0, so a defensive empty card can never show "0 postings - updated 20654d ago" (the
// epoch-freshness bug). The Recharts subtree is stubbed - this test is about the foot source line only.
vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

import { InsightCard } from "@/components/insight/InsightCard";

function insightWith(sampleN: number, updatedAt: string): DataInsight {
  return {
    id: "src-line",
    kind: "chart",
    chartType: "histogram",
    verdict: "The median salary is 180000 here.",
    series: [{ bucket: 160000, count: 3, median: 180000 }],
    followups: [],
    meta: { sql: "SELECT 1", sampleN, updatedAt },
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
