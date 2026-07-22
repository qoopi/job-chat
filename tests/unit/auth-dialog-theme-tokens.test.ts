import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Every color-bearing declaration in the auth-dialog selectors must reference a themed custom
// property (var(--token), which [data-theme="Dark"] overrides elsewhere in globals.css), so a future
// edit cannot silently hardcode a light-mode-only color. `.overlay`'s scrim is the one deliberate
// exception - a literal rgba() in the design handoff mock itself (frame 3a) with no dark variant,
// i.e. intentionally theme-invariant; pinned here so that stays a decision, not a drift.
const CSS_PATH = resolve(process.cwd(), "src/app/globals.css");
const css = readFileSync(CSS_PATH, "utf8");

function ruleBody(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector ${selector} not found in globals.css`).toBeGreaterThanOrEqual(0);
  const close = css.indexOf("}", at);
  return css.slice(at, close);
}

const COLOR_PROPS = /\b(?:color|background|background-color|border-color|border)\s*:\s*([^;]+);/g;
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|rgba?\(/i;

function assertAllColorsTokenized(selector: string) {
  const body = ruleBody(selector);
  const literals: string[] = [];
  for (const m of body.matchAll(COLOR_PROPS)) {
    const value = m[1];
    if (LITERAL_COLOR.test(value) && !value.includes("var(")) literals.push(value.trim());
  }
  expect(literals, `${selector} has non-tokenized color(s): ${literals.join(", ")}`).toEqual([]);
}

describe("AC-18 auth-dialog surfaces are token-driven (dark-theme flip precondition)", () => {
  it.each([".dialog", ".dialog h3", ".dialog .sub", ".divider", ".field input", ".field-error", ".dialog-note"])(
    "%s: every color is a var(--token), not a literal",
    (selector) => assertAllColorsTokenized(selector),
  );

  it(".overlay's backdrop scrim is the deliberate, mock-matching exception (not tokenized by design)", () => {
    const body = ruleBody(".overlay");
    expect(body).toContain("background: rgba(24, 24, 27, 0.38);");
  });
});
