import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 043 history-card contract, locked at the source (jsdom does no layout, so magnitudes/tokens live here).
// Two invariants the operator called out:
//  1. The row reads as a VISIBLE card in both themes (a stepped surface + a hairline border), and it is a
//     block-level card - NOT an inline <a>. The inline <a> was the 043 sliver root cause: the global a{}
//     rule leaves .sb-item display:inline, so its background painted a thin left sliver instead of a filled
//     row. A regression back to inline (or dropping the border/fill) fails here.
//  2. REST / HOVER / ACTIVE are three DISTINCT states (039 review nit: hover must not equal active).
const CSS_PATH = resolve(process.cwd(), "src/app/globals.css");
// Strip /* block comments */ first: the .sb-item rule's own comment mentions `a{}` and `display:inline`,
// whose brace/colon would otherwise defeat the naive `{`..`}` rule-body slicing below.
const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Declaration block of a single rule, matched precisely by `${selector} {` (so `.sb-item {` never
 *  matches `.sb-item.active {` or `.sb-item-row {`). */
function ruleBody(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector ${selector} present in globals.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** The value of one property in a rule body (last wins), whitespace-normalized. */
function prop(body: string, name: string): string | undefined {
  let value: string | undefined;
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    if (decl.slice(0, i).trim() === name) value = decl.slice(i + 1).trim().replace(/\s+/g, " ");
  }
  return value;
}

describe("history card is a visible, block-level card (043 item 1 + sliver root cause)", () => {
  const rest = ruleBody(".sb-item");

  it("is a flex/block card, never an inline <a> (the sliver root cause)", () => {
    // display:inline would repaint the sliver bug; require an explicit non-inline display.
    expect(prop(rest, "display")).toBe("flex");
  });

  it("carries a resting fill AND a hairline border (reads as a card, not bare text)", () => {
    expect(prop(rest, "background")).toBe("var(--shell-active)");
    expect(prop(rest, "border")).toBe("1px solid var(--shell-border)");
  });

  it("keeps every color token-driven (so the dark-theme flip stays automatic)", () => {
    for (const decl of rest.matchAll(/\b(?:background|border|color)\s*:\s*([^;]+);/g)) {
      expect(decl[1], `non-tokenized color in .sb-item: ${decl[1]}`).toContain("var(");
    }
  });
});

describe("REST / HOVER / ACTIVE are three distinct states (039 nit: hover != active)", () => {
  const rest = ruleBody(".sb-item");
  const hover = ruleBody(".sb-item:hover");
  const active = ruleBody(".sb-item.active");

  it("each state paints a different background token", () => {
    const backgrounds = [
      prop(rest, "background"),
      prop(hover, "background"),
      prop(active, "background"),
    ];
    expect(new Set(backgrounds).size, `backgrounds must all differ, got ${backgrounds}`).toBe(3);
    // and specifically the 039 nit: hover !== active
    expect(prop(hover, "background")).not.toBe(prop(active, "background"));
  });

  it("hover lifts the surface and active is accent-tied", () => {
    expect(prop(hover, "background")).toBe("var(--sb-hover)");
    expect(prop(hover, "border-color")).toBe("var(--border-strong)");
    expect(prop(active, "background")).toBe("var(--accent-soft)");
    expect(prop(active, "border-color")).toBe("var(--accent-line)");
  });

  it("defines the derived --sb-hover token (flips with the theme, no dark override needed)", () => {
    expect(css).toMatch(/--sb-hover:\s*color-mix\([^;]*var\(--shell-active\)[^;]*var\(--shell-strong\)/);
  });

  it("orders .sb-item.active after .sb-item:hover so active wins at equal specificity", () => {
    expect(css.indexOf(".sb-item.active {")).toBeGreaterThan(css.indexOf(".sb-item:hover {"));
  });
});

describe("title ellipsis + kebab clearance (043 item 3)", () => {
  const title = ruleBody(".sb-item .sb-title");

  it("truncates with an ellipsis", () => {
    expect(prop(title, "overflow")).toBe("hidden");
    expect(prop(title, "text-overflow")).toBe("ellipsis");
    expect(prop(title, "white-space")).toBe("nowrap");
  });

  it("reserves the kebab's corner so a long title never runs under it", () => {
    expect(prop(title, "padding-right")).toBeTruthy();
  });
});
