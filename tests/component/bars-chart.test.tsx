// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BarsChart } from "@/components/insight/charts/BarsChart";

// The single-measure bars chart caps the visible bars at 8 and, when there are more,
// offers a "+ N more" affordance that opens the full series as a table in the detail panel. Recharts needs
// non-zero dimensions to render in jsdom, so shim the element-measurement APIs (as histogram-currency
// does). The "+ N more" affordance is plain DOM (outside the SVG), so it is asserted directly.
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = RO as unknown as typeof ResizeObserver;
  for (const prop of ["offsetWidth", "clientWidth"]) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: 800,
    });
  }
  for (const prop of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: 400,
    });
  }
  Element.prototype.getBoundingClientRect = () =>
    ({
      width: 800,
      height: 400,
      top: 0,
      left: 0,
      right: 800,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
});

const companies = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    company: `Company number ${i + 1}`,
    count: 100 - i,
  }));

afterEach(cleanup);

describe("BarsChart cap + overflow (refresh #2 s2)", () => {
  test("over the cap: renders a '+ N more' affordance that opens the full table", () => {
    const onShowAll = vi.fn();
    render(<BarsChart series={companies(12)} onShowAll={onShowAll} />);
    // 12 rows, cap 8 -> 4 hidden.
    const more = screen.getByRole("button", { name: /\+ 4 more/ });
    fireEvent.click(more);
    expect(onShowAll).toHaveBeenCalledOnce();
  });

  test("at/under the cap: no overflow affordance", () => {
    render(<BarsChart series={companies(8)} />);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  test("the hidden count reflects the 8-bar cap (20 rows -> 12 hidden)", () => {
    render(<BarsChart series={companies(20)} />);
    // proves the slice-to-BARS_CAP math: 20 - 8 shown = 12 hidden (label truncation itself is unit-tested).
    expect(screen.getByRole("button", { name: /\+ 12 more/ })).toBeTruthy();
  });
});
