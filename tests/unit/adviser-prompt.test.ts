import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("carries over honesty, city aliases, and no tool-mechanics narration", () => {
    expect(ADVISER_V2.toLowerCase()).toMatch(/never (make up|invent)|do not (make up|invent)/);
    expect(ADVISER_V2).toContain("San Francisco");
    expect(ADVISER_V2).toMatch(/\bSF\b/);
    expect(ADVISER_V2.toLowerCase()).toMatch(/never (narrate|describe|mention).*(tool|retry|query|call)/);
    expect(ADVISER_V2.toLowerCase()).toMatch(/no matching|no postings matched|nothing matched|empty/);
  });

  // 2026-07-21 vision refinement: report_unanswerable is retired from the scope path entirely. The
  // prompt no longer routes anything to it - a silent re-add of the instruction is a regression.
  it("no longer references report_unanswerable (retired from the scope path)", () => {
    expect(ADVISER_V2).not.toContain("report_unanswerable");
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

  // 010-polish round (v1-Q5 double-card fix): exactly one data tool per answer - one question, one card.
  // The strict eval scorer fails a right tool called beside a second data tool; the prompt now forbids it.
  it("pins the single-data-tool rule: exactly one data tool per answer, never a second card", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/exactly one data tool/);
    expect(p).toMatch(/never call a second data tool|no second data tool/);
  });

  // 2026-07-21 vision refinement (answer-anything-then-steer): the agent answers ANY question, then
  // politely steers back to jobs. These pins hold the taxonomy + guardrails the prompt now encodes.
  it("encodes the answer-anything-then-steer vision", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/answer any/); // "You can answer ANY question"
    expect(p).toContain("steer");
  });

  it("answers meta/identity transparently, naming the real stack (Claude / Bedrock / ClickHouse / Trigger.dev)", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toContain("claude");
    expect(p).toContain("bedrock");
    expect(p).toContain("clickhouse");
    expect(p).toContain("trigger.dev");
  });

  it("is honest about live data it lacks (weather/stocks/sports) and never fabricates a live number", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toContain("weather");
    expect(p).toMatch(/stock/);
    expect(p).toMatch(/score|sports/);
    expect(p).toMatch(/do not fetch|don't fetch|cannot fetch|fetch that live/);
    expect(p).toMatch(/never (invent|fabricate|make up).*(live|number|fact)/);
  });

  it("answers general knowledge it can, then steers home", () => {
    expect(ADVISER_V2.toLowerCase()).toMatch(/general knowledge|general-knowledge/);
  });

  it("guardrails: always steer to jobs, and stay out of medical/legal/financial professional advice (career IS in scope)", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/always .*steer|always end by steering/);
    expect(p).toContain("medical");
    expect(p).toContain("legal");
    expect(p).toContain("financial");
    expect(p).toContain("career");
  });
});

// Gap fill (05-testing audit): the cutover itself (task requirement 4 - "Cut trigger/chat.ts over to
// v2") had no regression test. createChatRun treats `system` as an opaque string (its own tests wire a
// placeholder "SYS"), and chat.agent()'s returned object does not expose its config for inspection, so a
// silent revert to ADVISER_V1 would pass every other test in the suite. A static source-content check
// (precedent: tests/unit/chat-resume-boundary.test.ts) is the cheap, deterministic seam available here.
describe("trigger/chat.ts is cut over to adviser-v2 (the shipped system prompt)", () => {
  it("wires ADVISER_V2, not the frozen ADVISER_V1, as the agent's system prompt", () => {
    const src = readFileSync(resolve(process.cwd(), "trigger/chat.ts"), "utf8");
    expect(src).toMatch(/system:\s*ADVISER_V2\b/);
    expect(src).not.toMatch(/system:\s*ADVISER_V1\b/);
  });
});
