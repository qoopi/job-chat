import { describe, expect, it } from "vitest";
import { ADVISER_V4 } from "../../trigger/prompts/adviser-v4";
import { ADVISER_V5, ADVISER_V5_VERSION } from "../../trigger/prompts/adviser-v5";

// Prompt v5: a NEW versioned file = v4's full content plus a Capabilities section. These pins hold BOTH
// halves of the contract - every v4 routing/guardrail/corpus/role-fit block survives into v5 (nothing
// dropped in the version bump), and the capabilities guidance is present and correct.
describe("adviser-v5 system prompt", () => {
  it("is versioned adviser-v5", () => {
    expect(ADVISER_V5_VERSION).toBe("adviser-v5");
  });

  it("carries EVERY v4 block forward intact (no block dropped in the bump)", () => {
    const blocks = ADVISER_V4.split("\n\n").map((b) => b.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThan(5);
    for (const block of blocks) expect(ADVISER_V5).toContain(block);
  });

  it("is a superset of v4, not identical, and keeps the closing line as the closer", () => {
    expect(ADVISER_V5).not.toBe(ADVISER_V4);
    expect(ADVISER_V5.length).toBeGreaterThan(ADVISER_V4.length);
    // The capabilities section sits BEFORE the closing paragraph (spliced in, not appended after the closer).
    expect(ADVISER_V5.indexOf("Capabilities")).toBeLessThan(
      ADVISER_V5.indexOf("Keep it brief, useful, and honest."),
    );
  });

  it("adds the capabilities section: brief reply + a suggest_questions call with discovery chips", () => {
    const p = ADVISER_V5;
    expect(p).toContain("Capabilities");
    expect(p).toContain("suggest_questions");
    // one personal-fit question plus corpus-grounded data questions
    expect(p).toContain("Find me a job that fits");
    expect(p.toLowerCase()).toContain("corpus");
  });

  it("scopes suggestions to the capabilities case only - data and fit routing are untouched", () => {
    // A specific data question still routes to a data tool; a fit-intent still follows FIT-INTENT ROUTING.
    expect(ADVISER_V5).toContain("FIT-INTENT ROUTING");
    expect(ADVISER_V5.toLowerCase()).toContain("only case where you call suggest_questions");
  });

  it("keeps the v4 role-fit + v3 corpus/company-fit guidance intact (composed, not replaced)", () => {
    expect(ADVISER_V5).toContain("Role-fit matching");
    expect(ADVISER_V5).toContain("Data awareness");
    expect(ADVISER_V5).toContain("Company-scoped fit");
  });
});
