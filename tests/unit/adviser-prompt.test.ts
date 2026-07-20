import { describe, expect, it } from "vitest";
import { ADVISER_V1, ADVISER_VERSION } from "../../trigger/prompts/adviser-v1";
import { ADVISER_V2, ADVISER_V2_VERSION } from "../../trigger/prompts/adviser-v2";

// The system prompt is a versioned, designed artifact. These assertions pin the load-bearing rules
// (AC-5 brevity, the two answer modes, honesty, the error taxonomy) so a future edit that drops one
// fails loudly. The live behavioural conformance (12-prompt sample) is measured in the dev round trip.
describe("adviser-v1 system prompt", () => {
  it("is versioned", () => {
    expect(ADVISER_VERSION).toBe("adviser-v1");
  });

  it("encodes the two answer modes", () => {
    expect(ADVISER_V1.toLowerCase()).toContain("two");
    expect(ADVISER_V1.toLowerCase()).toContain("plain");
  });

  it("encodes the <=2 sentence brevity rule for plain answers (AC-5)", () => {
    expect(ADVISER_V1.toLowerCase()).toMatch(/two sentences|2 sentences/);
  });

  it("encodes the honesty rule (never invent numbers; the tools carry the real figures)", () => {
    expect(ADVISER_V1.toLowerCase()).toMatch(/never (make up|invent)|do not (make up|invent)/);
  });

  it("routes unanswerable questions to the escape hatch, not a guess (AC-10)", () => {
    expect(ADVISER_V1).toContain("report_unanswerable");
  });

  // P1 polish: the model must expand well-known city abbreviations to the full city name BEFORE calling
  // a tool, so "SF" resolves to San Francisco on the first attempt (no narrated retry loop).
  it("instructs the model to normalize city abbreviations before calling tools (SF/NYC/LA)", () => {
    expect(ADVISER_V1).toContain("San Francisco");
    expect(ADVISER_V1).toContain("New York");
    expect(ADVISER_V1).toContain("Los Angeles");
    expect(ADVISER_V1).toMatch(/\bSF\b/);
    expect(ADVISER_V1).toMatch(/\bNYC\b/);
    expect(ADVISER_V1).toMatch(/\bLA\b/);
  });

  // P1 polish: never narrate tool mechanics ("Let me try with the full city name:") - answer with the
  // outcome only.
  it("forbids narrating the mechanics of a tool call", () => {
    expect(ADVISER_V1.toLowerCase()).toMatch(/never (narrate|describe|mention).*(tool|retry|query|call)/);
  });

  // P1 polish: an in-scope query that matched no postings is a plain-prose answer (no chart), distinct
  // from report_unanswerable (reserved for genuinely out-of-scope questions).
  it("answers an empty (0-row) result in plain prose, not a card", () => {
    expect(ADVISER_V1.toLowerCase()).toMatch(/no matching|no postings matched|nothing matched|empty/);
  });
});

// v2 extends v1: composition guidance for the seventh tool, chart-choice rules mirroring
// chartTypeForShape, and a tightened clarify-path tone. All v1 load-bearing rules carry over.
describe("adviser-v2 system prompt", () => {
  it("is versioned adviser-v2", () => {
    expect(ADVISER_V2_VERSION).toBe("adviser-v2");
  });

  it("carries over the two answer modes and the <=2-sentence plain rule", () => {
    expect(ADVISER_V2.toLowerCase()).toContain("two");
    expect(ADVISER_V2.toLowerCase()).toContain("plain");
    expect(ADVISER_V2.toLowerCase()).toMatch(/two sentences|2 sentences/);
  });

  it("carries over honesty, the unanswerable escape hatch, city aliases, and no tool-mechanics narration", () => {
    expect(ADVISER_V2.toLowerCase()).toMatch(/never (make up|invent)|do not (make up|invent)/);
    expect(ADVISER_V2).toContain("report_unanswerable");
    expect(ADVISER_V2).toContain("San Francisco");
    expect(ADVISER_V2).toMatch(/\bSF\b/);
    expect(ADVISER_V2.toLowerCase()).toMatch(/never (narrate|describe|mention).*(tool|retry|query|call)/);
    expect(ADVISER_V2.toLowerCase()).toMatch(/no matching|no postings matched|nothing matched|empty/);
  });

  it("teaches composition with query_postings and at least two worked examples (AC-1)", () => {
    expect(ADVISER_V2).toContain("query_postings");
    expect(ADVISER_V2.toLowerCase()).toContain("top companies in the us");
    // At least two worked examples reference the composed measures/dimensions vocabulary.
    expect(ADVISER_V2.toLowerCase()).toContain("median salary by experience level");
  });

  it("mirrors the chartTypeForShape chart-choice rules (trend/bars/donut/table, no composed histogram)", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toContain("trend");
    expect(p).toContain("bars");
    expect(p).toContain("donut");
    expect(p).toContain("table");
    // Donut is bounded to a small share-of-whole (mirrors the <=6-slice fallback).
    expect(p).toMatch(/share of a whole|share-of-whole|few slices|small number of slices/);
  });

  it("tightens the clarify-path tone (no exclamation, no filler opener) with a bad/good example pair", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/no exclamation|exclamation mark/);
    expect(p).toMatch(/filler|great question/);
    expect(p).toContain("bad:");
    expect(p).toContain("good:");
  });
});
