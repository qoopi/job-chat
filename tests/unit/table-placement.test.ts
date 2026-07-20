import { describe, expect, it } from "vitest";
import { LCP_TABLE_THRESHOLD, LCP_TABLE_PREVIEW_ROWS, tablePlacement } from "@/lib/table-placement";

// AC-8: the deterministic, client-side placement rule. A table of <= 8 rows renders inline; over the
// threshold it becomes a preview card that opens the full table in the LCP. The rule is a pure count
// check so the agent never decides placement and a resumed payload renders the same way. Boundary is
// the AC's literal contract (8 -> inline, 9 -> lcp), not recomputed the way the code computes it.

const rowsOf = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ i }));

describe("tablePlacement", () => {
  it("pins the threshold and preview-row constants to the design contract", () => {
    expect(LCP_TABLE_THRESHOLD).toBe(8);
    expect(LCP_TABLE_PREVIEW_ROWS).toBe(5);
  });

  it("keeps a table AT the threshold inline (8 rows)", () => {
    expect(tablePlacement(rowsOf(8))).toBe("inline");
  });

  it("sends a table OVER the threshold to the LCP (9 rows)", () => {
    expect(tablePlacement(rowsOf(9))).toBe("lcp");
  });

  it.each([
    [0, "inline"],
    [1, "inline"],
    [5, "inline"],
    [7, "inline"],
    [8, "inline"],
    [9, "lcp"],
    [20, "lcp"],
  ])("classifies a %i-row table as %s", (n, expected) => {
    expect(tablePlacement(rowsOf(n))).toBe(expected);
  });
});
