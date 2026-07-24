import { describe, expect, it } from "vitest";
import { ADVISER_V5 } from "../../trigger/prompts/adviser-v5";
import { ADVISER_V6, ADVISER_V6_VERSION } from "../../trigger/prompts/adviser-v6";

// Prompt v6: a NEW versioned file = v5's full content plus four routing refinements (response modes,
// data-path role matching, follow-up scope reinforcement, one-line how-to). These pins hold BOTH halves
// of the contract - every v5 routing/guardrail block survives (nothing dropped in the bump), and the new
// guidance is present and correct.
describe("adviser-v6 system prompt", () => {
  it("is versioned adviser-v6", () => {
    expect(ADVISER_V6_VERSION).toBe("adviser-v6");
  });

  it("carries EVERY v5 block forward intact (no block dropped in the bump)", () => {
    const blocks = ADVISER_V5.split("\n\n").map((b) => b.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThan(5);
    for (const block of blocks) expect(ADVISER_V6).toContain(block);
  });

  it("is a superset of v5, not identical, and keeps the closing line as the closer", () => {
    expect(ADVISER_V6).not.toBe(ADVISER_V5);
    expect(ADVISER_V6.length).toBeGreaterThan(ADVISER_V5.length);
    expect(ADVISER_V6.indexOf("RESPONSE MODE")).toBeLessThan(
      ADVISER_V6.indexOf("Keep it brief, useful, and honest."),
    );
  });

  it("routes a single-number count/existence question to a TEXT answer, no one-value chart", () => {
    const p = ADVISER_V6;
    expect(p).toContain("RESPONSE MODE");
    // a bare count is text, not a card
    expect(p.toLowerCase()).toContain("one-value chart");
    expect(p.toLowerCase()).toContain("no chart");
  });

  it("routes a request for specific job postings to the postings LIST, not a count or breakdown chart", () => {
    const p = ADVISER_V6.toLowerCase();
    expect(p).toContain("latest_postings");
    expect(p).toContain("show me");
    // the list is the answer, not a count and not a breakdown chart
    expect(p).toContain("not a count");
  });

  it("teaches data-path role matching so a named role keys off the canonical role, not the title words", () => {
    const p = ADVISER_V6;
    expect(p).toContain("DATA-PATH ROLE MATCHING");
    expect(p.toLowerCase()).toContain("role parameter");
    expect(p.toLowerCase()).toContain("canonical role");
  });

  it("reinforces follow-up scope: never widen or drop the subject; show-them repeats the prior filters", () => {
    const p = ADVISER_V6;
    expect(p).toContain("FOLLOW-UP SCOPE");
    expect(p.toLowerCase()).toContain("never");
    expect(p.toLowerCase()).toContain("show them");
    // the original inheritance block still stands
    expect(p).toContain("FOLLOW-UP INHERITANCE");
  });

  it("answers a how-to (using the app) in ONE short sentence, never a paragraph", () => {
    const p = ADVISER_V6;
    expect(p).toContain("HOW-TO");
    expect(p.toLowerCase()).toContain("one short sentence");
  });

  it("keeps the v5 capabilities + v4 role-fit + v3 corpus guidance intact (composed, not replaced)", () => {
    expect(ADVISER_V6).toContain("Capabilities");
    expect(ADVISER_V6).toContain("Role-fit matching");
    expect(ADVISER_V6).toContain("Data awareness");
    expect(ADVISER_V6).toContain("FIT-INTENT ROUTING");
  });
});
