// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DataInsight } from "@shared/insight";

// A single-scalar answer (a one-row, one-cell table whose only content is the number the verdict
// already states) renders as the verdict sentence alone - no degenerate one-cell table card and no
// Chart|Table tabs. Chips and "Show query" are unaffected.
vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

import { InsightCard } from "@/components/insight/InsightCard";

const scalarInsight: DataInsight = {
  id: "s1",
  kind: "table",
  verdict: "There are 3,488 open postings.",
  rows: [{ count: 3488 }],
  followups: ["How has this changed over time?", "Which companies are hiring most?"],
  meta: { sql: "SELECT count() FROM postings", sampleN: 3488, updatedAt: "2026-07-18 19:12:00" },
};

// Boundary: the single cell holds a formatted MONEY value, not a count - isSingleScalar is a shape
// check (one row, one cell), so a money scalar must render the same verdict-only way, with the money
// token still bolded by Verdict/splitFirstNumber.
const moneyScalarInsight: DataInsight = {
  id: "s2",
  kind: "table",
  verdict: "The average salary is $182k.",
  rows: [{ avg_salary: 182000 }],
  followups: [],
  meta: { sql: "SELECT avg(salary) FROM postings", sampleN: 3488, updatedAt: "2026-07-18 19:12:00" },
};

afterEach(cleanup);

describe("InsightCard single-scalar (AC-18)", () => {
  test("Should_RenderVerdictOnly_When_AnswerIsSingleScalar", () => {
    const { container } = render(<InsightCard insight={scalarInsight} />);

    // The verdict sentence renders.
    expect(container.querySelector(".verdict")?.textContent).toBe("There are 3,488 open postings.");
    // No degenerate one-cell table body, and no Chart|Table tabs to switch a scalar between.
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(screen.queryByRole("tab", { name: "Table" })).toBeNull();
  });

  test("chips and Show query are unaffected for a scalar answer", () => {
    const onFollowup = vi.fn();
    const { container } = render(<InsightCard insight={scalarInsight} onFollowup={onFollowup} />);

    // Chips still render and fire.
    fireEvent.click(screen.getByRole("button", { name: "Which companies are hiring most?" }));
    expect(onFollowup).toHaveBeenCalledWith("Which companies are hiring most?");

    // Show query still reveals the executed SQL (the CodeBlock tints tokens across spans, so read the
    // reassembled <pre> text).
    fireEvent.click(screen.getByRole("button", { name: "Show query" }));
    expect(container.querySelector(".codeblock pre")?.textContent).toBe("SELECT count() FROM postings");
  });

  test("a money-valued single-scalar (avg_salary, one row one cell) also renders verdict-only, money bolded", () => {
    const { container } = render(<InsightCard insight={moneyScalarInsight} />);

    expect(container.querySelector(".verdict")?.textContent).toBe("The average salary is $182k.");
    // The money token is the emphasized number inside the verdict (splitFirstNumber/Verdict), same as any
    // other scalar - scalar-ness does not depend on the cell being a count.
    expect(container.querySelector(".verdict b")?.textContent).toBe("$182k");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});
