import { describe, expect, it } from "vitest";
import {
  ABBREVIATION_PROMPTS,
  BANNED_OPENERS,
  P2_INTENT_PROMPTS,
  SAMPLE_PROMPTS,
  countSentences,
  startsWithBannedOpener,
} from "../fixtures/plain-prompts";

// AC-5 deterministic slice: the conformance sample is the named 19-prompt fixture, and the tone harness
// (sentence count + banned-opener check) behaves. The live pass/fail (every plain answer <= 2 sentences,
// no "!", no banned opener against Bedrock) is a manual gate recorded in the Completion Report - it needs
// a live LLM, like AC-16's edge rule and AC-18's visual review.
describe("AC-5 plain-answer conformance harness", () => {
  it("samples the named 19 prompts (7 launch + 5 conversational + 1 abbreviation + 6 P2-intent)", () => {
    expect(SAMPLE_PROMPTS).toHaveLength(19);
  });

  it("includes the 6 P2-intent phrasings (find-me-a-job / what-fits-me class)", () => {
    expect(P2_INTENT_PROMPTS).toHaveLength(6);
    expect(SAMPLE_PROMPTS).toEqual(expect.arrayContaining(P2_INTENT_PROMPTS));
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

  // The banned-opener list is the ONE home (010's eval-set imports it); the predicate flags a filler
  // opener at the start of a reply, matched at a word boundary so it never trips a real word.
  it("enumerates a non-empty banned-opener list", () => {
    expect(BANNED_OPENERS.length).toBeGreaterThan(0);
    expect(BANNED_OPENERS).toEqual(expect.arrayContaining(["great question", "certainly", "of course"]));
  });

  it("startsWithBannedOpener flags filler openers and passes clean plain answers", () => {
    expect(startsWithBannedOpener("Great question! Here is the data.")).toBe(true);
    expect(startsWithBannedOpener("Certainly, the median is 180000.")).toBe(true);
    expect(startsWithBannedOpener("Sure thing, let us look.")).toBe(true);
    expect(startsWithBannedOpener("Of course - remote roles are common.")).toBe(true);
    // Clean plain answers (and real words that merely begin with a banned opener) are not flagged.
    expect(startsWithBannedOpener("Now is a decent time to look.")).toBe(false);
    expect(startsWithBannedOpener("Software roles lead the market.")).toBe(false);
    expect(startsWithBannedOpener("Greater Boston is hiring.")).toBe(false);
  });
});
