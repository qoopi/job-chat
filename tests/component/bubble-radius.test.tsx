// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Bubble } from "@/components/chat/Bubble";

// A bubble whose content wraps past one line carries `.wrapped` (which CSS maps to --r-lg); a
// single-line bubble keeps the plain `.bubble` (--r-pill). jsdom does no layout, so we stand in for the
// browser's measurement by making scrollHeight a function of the rendered text length - short text
// measures as one line, long text as multiple. The detection code under test (getComputedStyle +
// scrollHeight threshold -> className) runs for real; only the layout number is supplied.
let original: PropertyDescriptor | undefined;
beforeAll(() => {
  original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      // > 40 chars stands in for a bubble that wrapped to two lines (~60px), else one line (~20px).
      return (this.textContent?.length ?? 0) > 40 ? 60 : 20;
    },
  });
});
afterAll(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
});
afterEach(cleanup);

const bubble = (c: HTMLElement) => c.querySelector(".bubble") as HTMLElement;

describe("Bubble radius (AC-17)", () => {
  test("Should_ReduceRadius_When_BubbleWraps", () => {
    const { container } = render(
      <Bubble role="ai">
        Postings are up 12% this quarter and senior engineering roles close fastest of all.
      </Bubble>,
    );
    expect(bubble(container).classList.contains("wrapped")).toBe(true);
  });

  test("Should_KeepPillRadius_When_SingleLine", () => {
    const { container } = render(<Bubble role="user">Top companies?</Bubble>);
    expect(bubble(container).classList.contains("wrapped")).toBe(false);
  });
});
