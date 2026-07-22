// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CodeBlock } from "@/components/insight/CodeBlock";

// The Show-query SQL must read as clean, complete SQL - every token type contrasts on
// its own surface. The token classes carry the palette; here we assert the tokenizer TAGS each type so
// the CSS can color them. Function names (count, quantile, ...) get a `.fn` class
// (they used to fall through as plain identifiers, indistinct from column names).
const SQL =
  "SELECT count(*), quantile(0.5)(salary_usd) AS median FROM jobs.postings WHERE city = 'San Francisco'";

const tint = (c: HTMLElement, cls: string) =>
  Array.from(c.querySelectorAll(`.${cls}`)).map((n) => n.textContent);

afterEach(cleanup);

describe("CodeBlock syntax tint (refresh #2 s1)", () => {
  test("tags function names with .fn (count, quantile), not plain identifiers", () => {
    const { container } = render(<CodeBlock sql={SQL} />);
    const fns = tint(container, "fn");
    expect(fns).toContain("count");
    expect(fns).toContain("quantile");
  });

  test("keeps keyword / string / number tinting for the other token types", () => {
    const { container } = render(<CodeBlock sql={SQL} />);
    expect(tint(container, "kw")).toEqual(
      expect.arrayContaining(["SELECT", "FROM", "WHERE", "AS"]),
    );
    expect(tint(container, "str")).toContain("'San Francisco'");
    expect(tint(container, "num")).toContain("0.5");
  });

  test("bare column/table identifiers stay plain (no .fn tint) so they read as identifiers", () => {
    const { container } = render(<CodeBlock sql={SQL} />);
    const fns = tint(container, "fn");
    // salary_usd is an argument, not a called function - it must NOT be tinted as a function.
    expect(fns).not.toContain("salary_usd");
    expect(fns).not.toContain("postings");
  });
});
