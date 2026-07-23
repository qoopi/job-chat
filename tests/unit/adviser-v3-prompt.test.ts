import { describe, expect, it } from "vitest";
import { ADVISER_V2 } from "../../trigger/prompts/adviser-v2";
import { ADVISER_V3, ADVISER_V3_VERSION } from "../../trigger/prompts/adviser-v3";

// Prompt v3 (044 AC-4/AC-5): a NEW versioned file = v2's full content plus a Data-awareness (CORPUS note)
// section. These pins hold BOTH halves of the contract - every v2 routing/guardrail block survives into
// v3 (nothing dropped in the version bump), and the corpus-awareness guidance is present and correct.
describe("adviser-v3 system prompt (044)", () => {
  it("is versioned adviser-v3", () => {
    expect(ADVISER_V3_VERSION).toBe("adviser-v3");
  });

  it("carries EVERY v2 block forward intact (AC-5: no routing/guardrail block dropped in the bump)", () => {
    // v3 = v2 + one inserted section, nothing removed: every v2 paragraph must appear verbatim in v3.
    const blocks = ADVISER_V2.split("\n\n").map((b) => b.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThan(5);
    for (const block of blocks) expect(ADVISER_V3).toContain(block);
  });

  it("is a superset of v2, not identical, and keeps v2's closing line as the closer (AC-5)", () => {
    expect(ADVISER_V3).not.toBe(ADVISER_V2);
    expect(ADVISER_V3.length).toBeGreaterThan(ADVISER_V2.length);
    expect(ADVISER_V3).toContain("The response is the product."); // v2's final sentence is preserved
    // The corpus section sits BEFORE the closing paragraph (spliced in, not appended after the closer).
    expect(ADVISER_V3.indexOf("Data awareness")).toBeLessThan(
      ADVISER_V3.indexOf("Keep it brief, useful, and honest."),
    );
  });

  it("adds the CORPUS-awareness section: treat the note as the source of truth for what exists (AC-4)", () => {
    const p = ADVISER_V3.toLowerCase();
    expect(p).toContain("corpus note");
    expect(p).toContain("source of truth");
  });

  it("teaches the absent-value behaviour: say so plainly and offer the nearest present value (AC-4)", () => {
    const p = ADVISER_V3.toLowerCase();
    expect(p).toMatch(/absent from the corpus/);
    expect(p).toContain("nearest");
    // never call a tool you can already see returns nothing
    expect(p).toMatch(/do not call a tool|will return nothing|returns nothing/);
  });

  it("treats country as a SAMPLE, not a COMPLETE family (044 review fix)", () => {
    // Only experience_level/employment_type/location_kind are declared COMPLETE. `country` is capped
    // (top-N) in buildCorpusSql, so calling it COMPLETE would falsely refuse a country ranked past the
    // cap that DOES have data. Country joins cities as a busiest/sample list instead.
    const p = ADVISER_V3;
    expect(p).toContain("experience_level, employment_type, and location_kind lists are the COMPLETE set");
    expect(p).not.toMatch(/location_kind, and country lists are the COMPLETE set/);
    // The absent-value refusal must NOT be keyed on country; an unshown country is query-anyway like a city.
    expect(p.toLowerCase()).toMatch(/a city or country not shown may still have data/);
  });

  it("draws filter spellings from the note and keeps case-insensitive matching guidance (AC-4)", () => {
    const p = ADVISER_V3.toLowerCase();
    expect(p).toMatch(/filter spellings|spellings from/);
    expect(p).toContain("case-insensitive");
  });

  // The SF/NYC/LA abbreviation belt from v2 stays as belt alongside the CORPUS note.
  it("keeps the v2 city-abbreviation expansions as belt", () => {
    expect(ADVISER_V3).toContain("SF -> San Francisco");
    expect(ADVISER_V3).toContain("NYC -> New York");
    expect(ADVISER_V3).toContain("LA -> Los Angeles");
  });
});
