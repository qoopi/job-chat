import { describe, expect, it } from "vitest";
import { assertEvalEnabled, scoreCase, type Observed } from "../../evals/run";
import { CHART_BEARING, EVAL_SET } from "../../evals/eval-set";

// AC-6 offline smoke for the eval harness (dev tooling - deliberately minimal; AC-7 is the real, live
// gate). Two behaviours, both offline (no Bedrock): the runner REFUSES without JOBCHAT_EVAL=1, and its
// deterministic scorer scores a scripted transcript exactly as expected. The eval SET itself sits outside
// the vitest globs (top-level evals/), so this is the one place it is exercised in the suite.
describe("eval harness (offline smoke)", () => {
  it("Should_RefuseWithoutFlag_And_ScoreOneScriptedCase", () => {
    // Refuse without the flag (checked before any credential probe, so it fires with an empty env).
    expect(() => assertEvalEnabled({})).toThrow(/JOBCHAT_EVAL=1/);
    // The flag alone is not enough: Bedrock creds must be present too.
    expect(() => assertEvalEnabled({ JOBCHAT_EVAL: "1" })).toThrow(/Bedrock env/);
    // Fully enabled (flag + region + static keys) does not throw.
    expect(() =>
      assertEvalEnabled({
        JOBCHAT_EVAL: "1",
        AWS_REGION: "eu-central-1",
        AWS_ACCESS_KEY_ID: "x",
        AWS_SECRET_ACCESS_KEY: "y",
      }),
    ).not.toThrow();

    // Score one scripted composed transcript: the agent called query_postings with the expected params
    // and a "bars" chart pick, and a card was rendered - so tool, mode, chart, and params all pass.
    const composed = EVAL_SET.find((c) => c.id === "C1")!;
    const observed: Observed = {
      toolCalls: [
        {
          name: "query_postings",
          input: { measures: ["count"], dimensions: ["company"], country: "United States", chartType: "bars" },
        },
      ],
      text: "Google leads US hiring.",
      hasInsight: true,
    };
    const scored = scoreCase(composed, observed);
    expect(scored.toolPass).toBe(true);
    expect(scored.modePass).toBe(true);
    expect(scored.toolModePass).toBe(true);
    expect(scored.chartBearing).toBe(true);
    expect(scored.chartPass).toBe(true);
    expect(scored.paramsPass).toBe(true);

    // And a plain small-talk transcript that calls no tool scores as a passing plain answer.
    const smalltalk = EVAL_SET.find((c) => c.expect.mode === "plain" && c.expect.tool === undefined)!;
    const plainScored = scoreCase(smalltalk, {
      toolCalls: [],
      text: "I can show you salary and hiring data from the postings.",
      hasInsight: false,
    });
    expect(plainScored.toolModePass).toBe(true);
    expect(plainScored.formatPass).toBe(true);
  });

  it("pins the eval set to 30 cases with 12 chart-bearing (the AC-4 sample)", () => {
    expect(EVAL_SET).toHaveLength(30);
    expect(CHART_BEARING).toHaveLength(12);
    // Every chart-bearing case is a query_postings case (the only path with a RAW agent pick, AC-4).
    expect(CHART_BEARING.every((c) => c.expect.tool === "query_postings")).toBe(true);
  });
});
