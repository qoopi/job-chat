import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Audit focus (019 testing pass, AC-D1/D2/D4/D5): the Completion Report claims the shipped `.codeblock`/
// `.copy-btn` CSS is "the mirror verbatim" and calls D1/D2/D4/D5 pure visual gates - but the AC derivation
// (019-ac-derivation) names a deterministic UNIT test for each of D1/D4/D5 (D2's dark palette is the
// render-level gate, deferred). No such test existed: codeblock.test.tsx only covers the tokenizer
// (AC-D3), never the CSS values. This is that missing deterministic slice: parse each ruleset's
// declarations from both the shipped globals.css and the design mirror and diff them, so a future edit
// reverting to shell tokens or a hand-typed hex fails here instead of only on an operator's visual gate.
const GLOBALS_PATH = resolve(process.cwd(), "src/app/globals.css");
const MIRROR_PATH = resolve(
  process.cwd(),
  ".claude/design-spec/design_handoff_jobchat/_shared/components.css",
);
const globals = readFileSync(GLOBALS_PATH, "utf8");
const mirror = readFileSync(MIRROR_PATH, "utf8");

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector ${selector} not found`).toBeGreaterThanOrEqual(0);
  const close = css.indexOf("}", at);
  return css.slice(at + selector.length + 2, close);
}

/** Parse `prop: value;` declarations into a sorted, whitespace-normalized array - order-independent so
 *  reflowing a rule's declarations does not spuriously fail this. */
function declarations(body: string): string[] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.replace(/\s+/g, " "))
    .sort();
}

const SELECTORS = [
  ".codeblock",
  ".codeblock pre",
  ".codeblock .kw",
  ".codeblock .str",
  ".codeblock .num",
  ".codeblock .fn",
  ".codeblock .cm",
  '[data-theme="Dark"] .codeblock',
  '[data-theme="Dark"] .codeblock .kw',
  '[data-theme="Dark"] .codeblock .str',
  '[data-theme="Dark"] .codeblock .num',
  '[data-theme="Dark"] .codeblock .fn',
  ".copy-btn",
];

describe("CodeBlock CSS matches the design mirror verbatim (AC-D1/AC-D5)", () => {
  it.each(SELECTORS)(
    "%s: globals.css matches components.css declaration-for-declaration",
    (selector) => {
      expect(declarations(ruleBody(globals, selector))).toEqual(
        declarations(ruleBody(mirror, selector)),
      );
    },
  );
});

describe("CodeBlock CSS never regresses to the shell-bg bug (AC-D4)", () => {
  it("does not set .codeblock background to var(--shell-bg)", () => {
    expect(ruleBody(globals, ".codeblock")).not.toContain("--shell-bg");
  });

  it("does not hardcode the old #e4e4e7 identifier text color on .codeblock", () => {
    // #e4e4e7 is legitimately used elsewhere (it is the --border token's own light-theme value) - the
    // AC is specifically that the codeblock rule itself never sets its (identifier) text color to it.
    expect(ruleBody(globals, ".codeblock")).not.toContain("#e4e4e7");
  });

  it(".copy-btn uses surface tokens (var(--surface), var(--border-strong), var(--text-2)), not shell tokens", () => {
    const body = ruleBody(globals, ".copy-btn");
    expect(body).toContain("var(--surface)");
    expect(body).toContain("var(--border-strong)");
    expect(body).toContain("var(--text-2)");
    expect(body).not.toContain("--shell-");
  });
});
