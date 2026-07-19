import { describe, expect, it } from "vitest";
import { SAMPLE_PROMPTS, countSentences } from "../fixtures/plain-prompts";

// AC-5 deterministic slice: the conformance sample is the named 12-prompt fixture, and the sentence
// metric behaves. The live pass/fail (every plain answer <= 2 sentences against Bedrock) is a manual
// gate recorded in the Completion Report - it needs a live LLM, like AC-16's edge rule and AC-18's
// visual review.
describe("AC-5 plain-answer conformance harness", () => {
  it("samples the named 12 prompts (7 launch + 5 conversational)", () => {
    expect(SAMPLE_PROMPTS).toHaveLength(12);
  });

  it("countSentences measures the <=2 threshold correctly", () => {
    expect(countSentences("Now is a decent time to look.")).toBe(1);
    expect(countSentences("Yes. Hybrid means some days in the office.")).toBe(2);
    expect(countSentences("One. Two. Three.")).toBe(3);
    expect(countSentences("  ")).toBe(0);
  });
});
