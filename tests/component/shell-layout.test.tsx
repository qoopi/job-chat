import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Item 1 (operator 039): the shell proportions are a CSS contract - sidebar 20vw (with a 220px floor),
// chat docks to a 35vw rail when the detail panel is open (leaving ~45vw for the panel), and the
// collapsed icon rail stays 64px. jsdom does no layout, so the magnitudes are locked here at the source
// (the open/closed dock STRUCTURE - .canvas.docked + .detail-panel - is exercised in detail-panel.test.tsx).
const css = readFileSync(
  fileURLToPath(new URL("../../src/app/globals.css", import.meta.url)),
  "utf8",
);

/** The declarations block of a single CSS rule (first match of the selector). */
function ruleBody(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} present`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("shell layout proportions (item 1)", () => {
  test("sidebar is 20vw with a 220px floor", () => {
    const body = ruleBody(".sidebar {");
    expect(body).toMatch(/width:\s*20vw/);
    expect(body).toMatch(/min-width:\s*220px/);
  });

  test("the chat canvas docks to a 35vw rail (detail panel takes the ~45vw remainder)", () => {
    // flex-basis is the docked rail width; .canvas.docked zeroes flex-grow so the basis wins.
    expect(ruleBody(".canvas {")).toMatch(/flex:\s*1\s+1\s+35vw/);
  });

  test("the collapsed rail clears the 220px floor so it stays 64px", () => {
    const body = ruleBody(".sidebar.collapsed {");
    expect(body).toMatch(/width:\s*64px/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});
