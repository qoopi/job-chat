import { describe, expect, it } from "vitest";
import { ABBREVIATION_PROMPTS, SAMPLE_PROMPTS, countSentences } from "../fixtures/plain-prompts";

// AC-5 deterministic slice: the conformance sample is the named 12-prompt fixture, and the sentence
// metric behaves. The live pass/fail (every plain answer <= 2 sentences against Bedrock) is a manual
// gate recorded in the Completion Report - it needs a live LLM, like AC-16's edge rule and AC-18's
// visual review.
describe("AC-5 plain-answer conformance harness", () => {
  it("samples the named 13 prompts (7 launch + 5 conversational + 1 abbreviation)", () => {
    expect(SAMPLE_PROMPTS).toHaveLength(13);
  });

  it("includes a city-abbreviation phrasing (SF) so the alias rule rides the live conformance run", () => {
    expect(ABBREVIATION_PROMPTS.length).toBeGreaterThanOrEqual(1);
    expect(ABBREVIATION_PROMPTS.some((p) => /\bSF\b/.test(p))).toBe(true);
    expect(SAMPLE_PROMPTS).toEqual(expect.arrayContaining(ABBREVIATION_PROMPTS));
  });

  it("countSentences measures the <=2 threshold correctly", () => {
    expect(countSentences("Now is a decent time to look.")).toBe(1);
    expect(countSentences("Yes. Hybrid means some days in the office.")).toBe(2);
    expect(countSentences("One. Two. Three.")).toBe(3);
    expect(countSentences("  ")).toBe(0);
  });
});
