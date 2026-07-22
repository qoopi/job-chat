// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HistogramChart } from "@/components/insight/charts/HistogramChart";

// The salary histogram is the ONE surface that used to hardcode a `$`
// (formatUsd) for the axis, the tooltip, and the median marker. A Berlin/EUR salary distribution set
// carries `meta.currency: "EUR"`; the source line + Table tab already disclose it, so the chart must too
// (chart and source line must AGREE). This renders the real component with an EUR fixture and
// asserts the money labels read `€`, never `$`. Recharts needs non-zero dimensions to render its <text>
// in jsdom, so we shim the element-measurement APIs it reads.
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = RO as unknown as typeof ResizeObserver;
  for (const prop of ["offsetWidth", "clientWidth"]) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: 800 });
  }
  for (const prop of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: 400 });
  }
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
});

afterEach(cleanup);

const eurSeries = [
  { bucket: 40000, count: 2, median: 90000 },
  { bucket: 90000, count: 5, median: 90000 },
  { bucket: 140000, count: 1, median: 90000 },
];

describe("HistogramChart honors meta.currency (018 review-fix, should-fix S3)", () => {
  test("a EUR salary distribution labels money with €, never a hardcoded $", () => {
    const { container } = render(<HistogramChart series={eurSeries} currency="EUR" />);
    const text = container.textContent ?? "";
    expect(text).toContain("median €90k"); // the median marker uses the real currency
    expect(text).toContain("€"); // axis/tooltip money too
    expect(text).not.toContain("$"); // the bug: a EUR set asserting a $ it is not in
  });

  test("defaults to $ (USD) when no currency is passed - existing callers unchanged", () => {
    const { container } = render(<HistogramChart series={eurSeries} />);
    expect(container.textContent ?? "").toContain("median $90k");
  });
});
