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

  it("pins the eval set to 35 cases with 12 chart-bearing (the AC-4 sample)", () => {
    // 018 strand 4/5: +4 follow-up/fragmentation/currency cases and +1 market-wide scope case, kept
    // non-chart-bearing so the AC-4 chart sample stays at 12 (they exercise tool/mode/params, not chart).
    expect(EVAL_SET).toHaveLength(35);
    expect(CHART_BEARING).toHaveLength(12);
    // Every chart-bearing case is a query_postings case (the only path with a RAW agent pick, AC-4).
    expect(CHART_BEARING.every((c) => c.expect.tool === "query_postings")).toBe(true);
  });
});

// Adversarial audit (05-testing, 2026-07-20): hand-built WRONG transcripts, checking that scoreCase
// actually fails them rather than silently passing. Confirms the reported 90%/100% gates mean something
// for tool identity + mode + raw chart pick, and pins two things that are informational-only by design
// (params-subset, formatRules never gate toolModePass). The extra-tool case below asserts the STRICT rule
// (010 review round): the tool check is an exact single-call match - the expected data tool called once,
// with no other data tool - so the saved v1 Q5 double-call (share_split + query_postings) FAILS, not
// passes (that leniency is now closed). See the Test Report + review-fixes doc for the full writeup.
describe("scoreCase adversarial probes (is the reported gate strict enough?)", () => {
  it("right tool, but no insight rendered (mode mismatch) fails toolModePass - a correct tool never masks a mode miss", () => {
    const dataCase = EVAL_SET.find((c) => c.id === "Q1")!; // expect: mode=data, tool=salary_distribution
    const observed: Observed = {
      toolCalls: [{ name: dataCase.expect.tool!, input: dataCase.expect.params ?? {} }],
      text: "No matching postings for that filter.",
      hasInsight: false, // e.g. an empty result - the tool ran, but no card was emitted
    };
    const scored = scoreCase(dataCase, observed);
    expect(scored.toolPass).toBe(true);
    expect(scored.modePass).toBe(false);
    expect(scored.toolModePass).toBe(false);
  });

  it("tool check is an exact single-call match: an extra data tool alongside the right one FAILS (real v1 Q5 hit this)", () => {
    const dataCase = EVAL_SET.find((c) => c.id === "Q5")!; // expect: mode=data, tool=share_split
    const observed: Observed = {
      toolCalls: [
        { name: dataCase.expect.tool!, input: dataCase.expect.params ?? {} },
        {
          name: "query_postings",
          input: { measures: ["count"], dimensions: ["experience_level"], chartType: "donut" },
        },
      ],
      text: "Senior roles make up about 40% of postings.",
      hasInsight: true,
    };
    const scored = scoreCase(dataCase, observed);
    expect(scored.toolPass).toBe(false); // a second data tool = a second card; the strict rule fails it
    expect(scored.toolModePass).toBe(false);
  });

  it("params-subset check bites: a MISSING expected key fails paramsPass, it is not silently treated as a match", () => {
    const composed = EVAL_SET.find((c) => c.id === "C1")!; // expect params: measures, dimensions, country
    const observed: Observed = {
      toolCalls: [
        { name: "query_postings", input: { measures: ["count"], dimensions: ["company"], chartType: "bars" } }, // country dropped
      ],
      text: "Google leads US hiring.",
      hasInsight: true,
    };
    const scored = scoreCase(composed, observed);
    expect(scored.paramsChecked).toBe(true);
    expect(scored.paramsPass).toBe(false);
  });

  it("params-subset check bites: a WRONG value for an expected key fails paramsPass", () => {
    const composed = EVAL_SET.find((c) => c.id === "C1")!;
    const observed: Observed = {
      toolCalls: [
        {
          name: "query_postings",
          input: { measures: ["count"], dimensions: ["company"], country: "Germany", chartType: "bars" },
        },
      ],
      text: "Google leads US hiring.",
      hasInsight: true,
    };
    const scored = scoreCase(composed, observed);
    expect(scored.paramsPass).toBe(false);
  });

  it("a chart-bearing case where the tool call never records a chartType fails the chart pick - it does not silently pass", () => {
    const composed = EVAL_SET.find((c) => c.id === "C1")!;
    const observed: Observed = {
      toolCalls: [
        { name: "query_postings", input: { measures: ["count"], dimensions: ["company"], country: "United States" } }, // no chartType key
      ],
      text: "Google leads US hiring.",
      hasInsight: true,
    };
    const scored = scoreCase(composed, observed);
    expect(scored.chartBearing).toBe(true);
    expect(scored.rawChartType).toBeUndefined();
    expect(scored.chartPass).toBe(false);
  });

  it("a chart-bearing case with the WRONG raw chartType fails the chart pick", () => {
    const composed = EVAL_SET.find((c) => c.id === "C6")!; // expect chartType "trend"
    const observed: Observed = {
      toolCalls: [
        { name: "query_postings", input: { measures: ["median_salary"], bucket: "month", chartType: "bars" } },
      ],
      text: "Median salary rose steadily.",
      hasInsight: true,
    };
    const scored = scoreCase(composed, observed);
    expect(scored.rawChartType).toBe("bars");
    expect(scored.chartPass).toBe(false);
  });

  it("formatRules fires on an over-length plain answer or a banned opener - but never gates toolModePass (informational only, matching the printed report)", () => {
    const plain = EVAL_SET.find((c) => c.id === "P2-1")!; // plain, no tool, formatRules: true
    const tooLong = scoreCase(plain, {
      toolCalls: [],
      hasInsight: false,
      text: "I can show hiring data. I can also show salary data. Just ask me a question.",
    });
    expect(tooLong.formatPass).toBe(false); // 3 sentences
    expect(tooLong.toolModePass).toBe(true); // format never gates the AC-7 unit

    const bannedOpener = scoreCase(plain, {
      toolCalls: [],
      hasInsight: false,
      text: "Great question! I can show salary data from the postings.",
    });
    expect(bannedOpener.formatPass).toBe(false); // banned opener + "!"
    expect(bannedOpener.toolModePass).toBe(true);
  });

  it("an off-domain case answered with a data card fails on BOTH tool and mode", () => {
    const offDomain = EVAL_SET.find((c) => c.id === "U1")!; // expect: plain mode, NO tool (answer + steer)
    const observed: Observed = {
      toolCalls: [{ name: "top_companies", input: { days: 30 } }], // guessed a tool instead of answering plainly
      text: "Some companies post more during certain seasons.",
      hasInsight: true,
    };
    const scored = scoreCase(offDomain, observed);
    expect(scored.toolPass).toBe(false); // a data tool where none was expected (plain, no tool)
    expect(scored.modePass).toBe(false); // a data card where plain prose was expected
    expect(scored.toolModePass).toBe(false);
  });
});
