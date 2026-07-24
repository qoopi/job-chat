import { describe, expect, it } from "vitest";
import { ADVISER_V3 } from "../../trigger/prompts/adviser-v3";
import { ADVISER_V4, ADVISER_V4_VERSION } from "../../trigger/prompts/adviser-v4";

// Prompt v4: a NEW versioned file = v3's full content plus a Role-fit section. These pins hold BOTH
// halves of the contract - every v3 routing/guardrail/corpus block survives into v4 (nothing dropped in
// the version bump), and the role-fit guidance is present and correct.
describe("adviser-v4 system prompt", () => {
  it("is versioned adviser-v4", () => {
    expect(ADVISER_V4_VERSION).toBe("adviser-v4");
  });

  it("carries EVERY v3 block forward intact (no block dropped in the bump)", () => {
    // v4 = v3 + one inserted section, nothing removed: every v3 paragraph must appear verbatim in v4.
    const blocks = ADVISER_V3.split("\n\n").map((b) => b.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThan(5);
    for (const block of blocks) expect(ADVISER_V4).toContain(block);
  });

  it("is a superset of v3, not identical, and keeps the closing line as the closer", () => {
    expect(ADVISER_V4).not.toBe(ADVISER_V3);
    expect(ADVISER_V4.length).toBeGreaterThan(ADVISER_V3.length);
    // The role-fit section sits BEFORE the closing paragraph (spliced in, not appended after the closer).
    expect(ADVISER_V4.indexOf("Role-fit matching")).toBeLessThan(
      ADVISER_V4.indexOf("Keep it brief, useful, and honest."),
    );
  });

  it("adds the role-fit section: pass a named role in search_postings' roles parameter", () => {
    const p = ADVISER_V4;
    expect(p.toLowerCase()).toContain("role-fit matching");
    expect(p).toContain("search_postings");
    expect(p.toLowerCase()).toMatch(/roles parameter/);
    // titleTerms is taught as the fallback the match now uses for unclassified postings.
    expect(p).toContain("titleTerms");
    expect(p.toLowerCase()).toContain("fallback");
  });

  it("keeps the v3 corpus + company-fit guidance as belt (composed, not replaced)", () => {
    expect(ADVISER_V4).toContain("Data awareness");
    expect(ADVISER_V4).toContain("Company-scoped fit");
  });
});
