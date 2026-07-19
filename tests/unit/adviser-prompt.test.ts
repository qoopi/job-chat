import { describe, expect, it } from "vitest";
import { ADVISER_V1, ADVISER_VERSION } from "../../trigger/prompts/adviser-v1";

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
});
