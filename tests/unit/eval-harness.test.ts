import { describe, expect, it } from "vitest";
import { assertEvalEnabled, runCase, selectEvalCases, type EvalStreamModel, type Observed } from "../evals/runner";
import { scoreCase } from "../evals/scorer";
import { CHART_BEARING, EVAL_SET, type EvalCase } from "../evals/eval-set";
import type { ModelMessage } from "../../trigger/parts";

// Offline smoke for the eval harness (dev tooling - deliberately minimal; the live run is the real
// gate). Two behaviours, both offline (no Bedrock): the runner REFUSES without JOBCHAT_EVAL=1, and its
// deterministic scorer scores a scripted transcript exactly as expected. The eval SET itself sits outside
// the vitest globs (tests/evals/), so this is the one place it is exercised in the suite.
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
      renderedCard: true,
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
      renderedCard: false,
    });
    expect(plainScored.toolModePass).toBe(true);
    expect(plainScored.formatPass).toBe(true);
  });

  it("pins the eval set to 40 cases with 12 chart-bearing (the AC-4 sample)", () => {
    // 030 added 5 profile-driven fit cases (guest-invite, signed-in-invite, two with-profile searches,
    // and a profile+off-topic guardrail), kept non-chart-bearing so the chart sample stays at 12.
    expect(EVAL_SET).toHaveLength(40);
    expect(CHART_BEARING).toHaveLength(12);
    // Every chart-bearing case is a query_postings case (the only path with a RAW agent pick).
    expect(CHART_BEARING.every((c) => c.expect.tool === "query_postings")).toBe(true);
  });
});

// The JOBCHAT_EVAL_IDS subset filter (fixes the dead env earlier testing flagged). A real id-subset
// filter so the spot-check the env name always promised actually works: match on case ids, report the
// skipped count (no silent caps), unset = the full exam. Pure function, so covered offline.
describe("selectEvalCases (JOBCHAT_EVAL_IDS subset filter)", () => {
  it("runs the full set when the env is unset or empty, skipping nothing", () => {
    for (const raw of [undefined, "", "  ", " , ,"]) {
      const { cases, skipped } = selectEvalCases(EVAL_SET, raw);
      expect(cases).toHaveLength(EVAL_SET.length);
      expect(skipped).toBe(0);
    }
  });

  it("restricts the run to the requested ids and reports the rest as skipped", () => {
    const { cases, skipped } = selectEvalCases(EVAL_SET, "Q1,C1");
    expect(cases.map((c) => c.id)).toEqual(["Q1", "C1"]);
    expect(skipped).toBe(EVAL_SET.length - 2);
  });

  // A repeated id must select its case ONCE, not run it twice - and must
  // count as ONE skip toward "the rest", not deflate the skipped count by the duplicate.
  it("dedupes a repeated id: selects it once, skipped counts every OTHER case exactly once", () => {
    const { cases, skipped } = selectEvalCases(EVAL_SET, "Q1,Q1,C1");
    expect(cases.map((c) => c.id)).toEqual(["Q1", "C1"]);
    expect(skipped).toBe(EVAL_SET.length - 2);
  });

  it("tolerates whitespace and trailing commas around ids", () => {
    const { cases } = selectEvalCases(EVAL_SET, " Q1 , , C1 ,");
    expect(cases.map((c) => c.id)).toEqual(["Q1", "C1"]);
  });

  it("a single id selects exactly one live case (the one-case boot check)", () => {
    const { cases, skipped } = selectEvalCases(EVAL_SET, "Q1");
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("Q1");
    expect(skipped).toBe(EVAL_SET.length - 1);
  });

  it("ids that match nothing simply skip everything - never a silent full run", () => {
    const { cases, skipped } = selectEvalCases(EVAL_SET, "NOPE");
    expect(cases).toHaveLength(0);
    expect(skipped).toBe(EVAL_SET.length);
  });
});

// The eval's context-turn replay loop (runCase) had no offline coverage - its model
// seam was hard-wired to Bedrock. The seam is now injectable, so a FAKE model drives a 2-turn case
// (context Q1 -> scored Q2) with zero network. The point being proven: a follow-up inherits the prior
// turn through the STORE (persistAssistantTurn -> buildModelHistory rebuild), not an SDK cross-turn replay.
describe("runCase context-turn replay (offline, fake model - 018 review-fix R2)", () => {
  it("replays a context turn's PERSISTED verdict into the next turn's rebuilt model input (store, not SDK)", async () => {
    const captured: ModelMessage[][] = [];
    const TURN1_VERDICT = "Google leads with 4 of 8 postings.";
    // Capture the exact rebuilt `messages` handed to the model each turn; answer turn 1 with the verdict
    // (runCase persists it). No Bedrock, no tool calls, no JOBCHAT_EVAL flag needed.
    const fakeModel: EvalStreamModel = ({ messages }) => {
      const turn = captured.push(messages.map((m) => ({ ...m }))); // push returns the new 1-based length
      return {
        consumeStream: async () => {},
        steps: Promise.resolve([]),
        text: Promise.resolve(turn === 1 ? TURN1_VERDICT : "Of those, a handful are in San Francisco."),
      };
    };
    const twoTurn: EvalCase = {
      id: "R2",
      question: "How many of those are in SF?",
      context: ["Which companies are hiring the most?"],
      expect: { mode: "data", tool: "query_postings" },
    };

    await runCase(fakeModel, "SYSTEM PROMPT", twoTurn);

    expect(captured).toHaveLength(2);
    // Turn 1 sees only its own user question - nothing prior.
    expect(captured[0].map((m) => m.role)).toEqual(["user"]);
    expect(captured[0][0].content).toContain("Which companies");
    // Turn 2's rebuilt history carries the PERSISTED turn-1 verdict as the assistant slot, in valid
    // user/assistant/user alternation - so the follow-up inherits through the store, not the SDK replay.
    const turn2 = captured[1];
    expect(turn2.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(turn2[1]).toEqual({ role: "assistant", content: TURN1_VERDICT });
    expect(turn2[2].content).toContain("SF");
  });
});

// Adversarial probes: hand-built WRONG transcripts, checking scoreCase actually FAILS them - so the
// reported gates mean something for tool identity + mode + raw chart pick. Pins the STRICT tool rule
// (exact single-call match: the expected data tool called once, no other data tool - a double-call
// fails) and that params-subset + formatRules stay informational (never gate toolModePass).
describe("scoreCase adversarial probes (is the reported gate strict enough?)", () => {
  it("right tool, but no insight rendered (mode mismatch) fails toolModePass - a correct tool never masks a mode miss", () => {
    const dataCase = EVAL_SET.find((c) => c.id === "Q1")!; // expect: mode=data, tool=salary_distribution
    const observed: Observed = {
      toolCalls: [{ name: dataCase.expect.tool!, input: dataCase.expect.params ?? {} }],
      text: "No matching postings for that filter.",
      renderedCard: false, // e.g. an empty result - the tool ran, but no card was emitted
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
      renderedCard: true,
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
      renderedCard: true,
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
      renderedCard: true,
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
      renderedCard: true,
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
      renderedCard: true,
    };
    const scored = scoreCase(composed, observed);
    expect(scored.rawChartType).toBe("bars");
    expect(scored.chartPass).toBe(false);
  });

  it("formatRules fires on an over-length plain answer or a banned opener - but never gates toolModePass (informational only, matching the printed report)", () => {
    const plain = EVAL_SET.find((c) => c.id === "S-1")!; // plain, no tool, formatRules: true (P2 is now a fit-intent)
    const tooLong = scoreCase(plain, {
      toolCalls: [],
      renderedCard: false,
      text: "I can show hiring data. I can also show salary data. Just ask me a question.",
    });
    expect(tooLong.formatPass).toBe(false); // 3 sentences
    expect(tooLong.toolModePass).toBe(true); // format never gates the tool+mode unit

    const bannedOpener = scoreCase(plain, {
      toolCalls: [],
      renderedCard: false,
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
      renderedCard: true,
    };
    const scored = scoreCase(offDomain, observed);
    expect(scored.toolPass).toBe(false); // a data tool where none was expected (plain, no tool)
    expect(scored.modePass).toBe(false); // a data card where plain prose was expected
    expect(scored.toolModePass).toBe(false);
  });
});

// The 030 fit-tool vocabulary: request_profile + search_postings are CARD tools (an invite / postings
// card => "data" mode), scored by the same strict single-card rule as the insight tools.
describe("scoreCase scores the profile-driven fit tools (030 vocabulary)", () => {
  it("a guest fit-intent scores as request_profile + data (the invite card renders)", () => {
    const guest = EVAL_SET.find((c) => c.id === "AUTH-1")!; // expect: mode=data, tool=request_profile
    const scored = scoreCase(guest, {
      toolCalls: [{ name: "request_profile", input: {} }],
      text: "",
      renderedCard: true, // the auth-invite card
    });
    expect(scored.toolPass).toBe(true);
    expect(scored.modePass).toBe(true);
    expect(scored.toolModePass).toBe(true);
  });

  it("a with-profile fit-intent scores as search_postings + data (the postings card renders)", () => {
    const search = EVAL_SET.find((c) => c.id === "SRCH-1")!; // expect: mode=data, tool=search_postings
    const scored = scoreCase(search, {
      toolCalls: [{ name: "search_postings", input: { titleTerms: ["backend"] } }],
      text: "",
      renderedCard: true, // the postings card
    });
    expect(scored.toolModePass).toBe(true);
  });

  it("search_postings called beside a second card tool FAILS (one answer, one card)", () => {
    const search = EVAL_SET.find((c) => c.id === "SRCH-1")!;
    const scored = scoreCase(search, {
      toolCalls: [
        { name: "search_postings", input: { titleTerms: ["backend"] } },
        { name: "top_companies", input: {} }, // a second card tool = a second card
      ],
      text: "",
      renderedCard: true,
    });
    expect(scored.toolPass).toBe(false);
    expect(scored.toolModePass).toBe(false);
  });

  it("a profile-present OFF-TOPIC question that over-fires search_postings FAILS (must stay plain)", () => {
    const offTopic = EVAL_SET.find((c) => c.id === "OFF-1")!; // expect: plain, NO tool
    const scored = scoreCase(offTopic, {
      toolCalls: [{ name: "search_postings", input: { titleTerms: ["engineer"] } }],
      text: "",
      renderedCard: true,
    });
    expect(scored.toolPass).toBe(false); // a card tool where none was expected
    expect(scored.modePass).toBe(false);
    expect(scored.toolModePass).toBe(false);
  });
});
