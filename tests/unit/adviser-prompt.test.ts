import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADVISER_V2, ADVISER_V2_VERSION } from "../../trigger/prompts/adviser-v2";

// The system prompt is a versioned, designed artifact. These assertions pin the load-bearing rules
// (brevity, the two answer modes, honesty, the error taxonomy) so a future edit that drops one
// fails loudly. The live behavioural conformance (12-prompt sample) is measured in the dev round trip.
// The frozen v1 baseline was retired (principles finding 9); v2 is the only prompt.
describe("adviser-v2 system prompt", () => {
  it("is versioned adviser-v2", () => {
    expect(ADVISER_V2_VERSION).toBe("adviser-v2");
  });

  // The flat "at most two sentences" resolves to answer-BODY <=2 sentences (small
  // answers like "Yes." stay small) PLUS one short steer sentence permitted on a redirect turn - so the
  // taxonomy's mandated answer+steer no longer contradicts the brevity cap.
  it("carries over the two answer modes and the answer-body <=2-sentence rule, permitting one steer sentence on redirect", () => {
    expect(ADVISER_V2.toLowerCase()).toContain("two");
    expect(ADVISER_V2.toLowerCase()).toContain("plain");
    // The answer BODY still holds at most two sentences.
    expect(ADVISER_V2.toLowerCase()).toMatch(/two sentences|2 sentences/);
    // ...and a redirect turn may add ONE short steer sentence beyond the body (the resolved contradiction).
    expect(ADVISER_V2.toLowerCase()).toContain("one short steer sentence");
  });

  it("carries over honesty, city aliases, and no tool-mechanics narration", () => {
    expect(ADVISER_V2.toLowerCase()).toMatch(/never (make up|invent)|do not (make up|invent)/);
    expect(ADVISER_V2).toContain("San Francisco");
    expect(ADVISER_V2).toMatch(/\bSF\b/);
    expect(ADVISER_V2.toLowerCase()).toMatch(/never (narrate|describe|mention).*(tool|retry|query|call)/);
    expect(ADVISER_V2.toLowerCase()).toMatch(/no matching|no postings matched|nothing matched|empty/);
  });

  // report_unanswerable is retired from the scope path entirely. The
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

  // Exactly one data tool per answer - one question, one card.
  // The strict eval scorer fails a right tool called beside a second data tool; the prompt now forbids it.
  it("pins the single-data-tool rule: exactly one data tool per answer, never a second card", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/exactly one data tool/);
    expect(p).toMatch(/never call a second data tool|no second data tool/);
  });

  // When a tool succeeds the card is the WHOLE answer - the model adds no prose (the
  // fabrication surface, where the model narrated companies with zero DB rows, is closed).
  it("forbids prose framing when a tool renders a card (the card is the answer)", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/add no prose|no prose/);
    expect(p).toMatch(/card.*(is|are).*(the )?(complete )?answer/);
  });

  // The model may never name an entity or number absent from the tool result it received.
  it("forbids naming any entity or number absent from the tool result", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/not present in the tool result|absent from (that|the) result|row labels/);
  });

  // A follow-up inheritance rule (carry the prior turn's filters, change only the named one)
  // and a multi-city example so "in LA or NYC" resolves via the cities IN-list.
  it("encodes the follow-up inheritance rule and multi-city guidance", () => {
    expect(ADVISER_V2).toContain("FOLLOW-UP INHERITANCE");
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/carry the prior|carry .*forward|inherit/);
    expect(p).toMatch(/la or nyc|los angeles.*new york/);
    expect(p).toContain("cities");
  });

  // A data-scope honesty rule - qualify whole-market questions to the sample, never present
  // the sample as the entire market (the concrete numbers arrive at runtime via the DATA SCOPE note).
  it("encodes the data-scope honesty rule (qualify whole-market questions to the sample)", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toContain("data scope");
    expect(p).toMatch(/whole job market|entire market|whole market/);
    expect(p).toMatch(/qualify/);
  });

  // Answer-anything-then-steer: the agent answers ANY question, then
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

  // Fit-intent routing (030): a personal job match is no longer a refusal. With a PROFILE note ->
  // search_postings; without one -> request_profile (the server picks the invite). The retired
  // "I cannot match you to roles" line must be gone.
  it("routes fit-intents to search_postings (with a profile) or request_profile (without), by the PROFILE note", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(ADVISER_V2).toContain("search_postings");
    expect(ADVISER_V2).toContain("request_profile");
    expect(p).toMatch(/fit-intent|personal (job )?match/);
    expect(p).toContain("profile note"); // routing keys off the per-turn PROFILE note
  });

  it("no longer refuses to match (the 'cannot match you to roles' line is retired)", () => {
    expect(ADVISER_V2.toLowerCase()).not.toContain("cannot match");
    expect(ADVISER_V2.toLowerCase()).toMatch(/can match people|unable to match/);
  });

  // Item 6 (register 22): a multi-turn divergence - after several fit turns the model kept answering a
  // GENERAL market question ("how is the job market doing") with the postings card instead of a data
  // answer. The fix is a routing reminder conditioning search_postings on EXPLICIT personal-fit wording.
  it("guards mode routing: search_postings is only for explicit personal fit; a market question stays a data answer", () => {
    const p = ADVISER_V2.toLowerCase();
    expect(p).toMatch(/only for an explicit personal fit|search_postings is only/);
    expect(p).toMatch(/how is the job market/);
    expect(p).toMatch(/data answer/);
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

// The cutover itself needs a pin: createChatRun treats `system` as an opaque string and chat.agent()
// does not expose its config for inspection, so a silent revert to ADVISER_V1 would pass every other
// test in the suite. A static source-content check is the cheap, deterministic seam available.
describe("trigger/chat.ts is cut over to adviser-v4 (the shipped system prompt)", () => {
  it("wires ADVISER_V4, not a frozen older version, as the agent's system prompt", () => {
    const src = readFileSync(resolve(process.cwd(), "trigger/chat.ts"), "utf8");
    expect(src).toMatch(/system:\s*ADVISER_V4\b/);
    expect(src).not.toMatch(/system:\s*ADVISER_V[123]\b/);
  });
});
