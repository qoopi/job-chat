import type { ChartType } from "@shared/insight";
import { LAUNCH_QUESTIONS } from "../tests/fixtures/launch-questions";
import { CONVERSATIONAL_PROMPTS, P2_INTENT_PROMPTS } from "../tests/fixtures/plain-prompts";

// The 30-case eval set: the regression net for agent flexibility (AC-6/AC-7/AC-4). Each case pins what
// the SHIPPED prompt + catalog should do with a question - the tool it should call, the answer mode, the
// params it should pass, and (for query_postings cases) the RAW chartType it should pick. The runner
// (evals/run.ts) drives each question through the real prompt + Bedrock and scores the agent's CHOICES
// against these expectations deterministically; it never judges the returned data (epic no-real-CH
// ruling). Composition of the 30:
//   - 7 launch questions        -> the six fixed templates (imported from the 003 fixture, DRY)
//   - 12 composed questions      -> query_postings, the AC-4 chart-bearing sample (>= 12 pinned)
//   - 4 P2-intent + 4 small-talk -> plain mode, no tool (imported from the 009 conformance fixture)
//   - 3 off-domain               -> plain mode, no tool (answer-or-honest-no-live-data + steer)
// The banned-opener list + tone harness live in ONE home (tests/fixtures/plain-prompts.ts, 009); the
// runner imports them there for format scoring - this file only marks which cases get the tone check.

/** The two answer modes the prompt defines: a DATA answer renders an insight card; PLAIN is prose only. */
export type EvalMode = "data" | "plain";

export interface EvalExpect {
  /** "data" = an insight card is rendered; "plain" = prose only (small talk, clarify, refusal). */
  mode: EvalMode;
  /** The tool the agent should call. Omitted = it should call NO tool (a pure plain answer). */
  tool?: string;
  /** A SUBSET the tool-call input must contain (present keys with matching values); never exact-object. */
  params?: Record<string, unknown>;
  /** Present => a chart-bearing case (the AC-4 sample): the RAW chartType pick the agent should make. */
  chartType?: ChartType | "table";
  /** Apply the AC-5 plain-tone conformance check to the answer text (<= 2 sentences, no "!", no filler). */
  formatRules?: boolean;
}

export interface EvalCase {
  id: string;
  question: string;
  /** Prior user turns to run (unscored) BEFORE `question`, establishing the history a follow-up inherits
   *  from (018 strand 4). The runner drives each in order, persisting the answer, then scores `question`. */
  context?: string[];
  expect: EvalExpect;
}

// The 7 launch questions -> the six fixed templates. Chart type is PINNED per template (not an agent
// pick), so these carry no `chartType` expectation and are NOT part of the AC-4 chart-bearing sample.
const LAUNCH_CASES: EvalCase[] = LAUNCH_QUESTIONS.map((q) => ({
  id: q.id,
  question: q.question,
  expect: { mode: "data", tool: q.tool, params: q.params },
}));

// The 12 composed questions -> query_postings. Each is genuinely outside the six template shapes (a
// country filter top_companies lacks, a salary-by-dimension or salary-over-time no template does, a
// title/city/employment_type grouping, or a two-dimension cross-tab), so the designed answer is the
// seventh tool. `chartType` is the RAW pick the v2 chart-choice rules call for: a category by a measure
// -> bars, a time bucket -> trend, a small share-of-whole -> donut, two groupings -> table. These 12 are
// the AC-4 chart-bearing sample.
const COMPOSED_CASES: EvalCase[] = [
  {
    id: "C1",
    question: "Which companies are hiring the most in the United States?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], dimensions: ["company"], country: "United States" },
      chartType: "bars",
    },
  },
  {
    id: "C2",
    question: "What is the median salary by experience level in Berlin?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["median_salary"], dimensions: ["experience_level"], city: "Berlin" },
      chartType: "bars",
    },
  },
  {
    id: "C3",
    question: "Which job titles are hiring the most right now?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], dimensions: ["title"] },
      chartType: "bars",
    },
  },
  {
    id: "C4",
    question: "Which countries have the highest median salaries?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["median_salary"], dimensions: ["country"] },
      chartType: "bars",
    },
  },
  {
    id: "C5",
    question: "Which cities have the most job postings?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], dimensions: ["city"] },
      chartType: "bars",
    },
  },
  {
    id: "C6",
    question: "How has the median salary changed month over month?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["median_salary"], bucket: "month" },
      chartType: "trend",
    },
  },
  {
    id: "C7",
    question: "What is the weekly trend in median salary for data engineers?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["median_salary"], bucket: "week", role: "Data Engineer" },
      chartType: "trend",
    },
  },
  {
    id: "C8",
    question: "How many postings were published each month this year?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], bucket: "month" },
      chartType: "trend",
    },
  },
  {
    id: "C9",
    question: "What share of postings falls under each employment type?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], dimensions: ["employment_type"] },
      chartType: "donut",
    },
  },
  {
    id: "C10",
    question: "Show median salary by country and experience level.",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["median_salary"], dimensions: ["country", "experience_level"] },
      chartType: "table",
    },
  },
  {
    id: "C11",
    question: "Break down posting counts by company and city.",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], dimensions: ["company", "city"] },
      chartType: "table",
    },
  },
  {
    id: "C12",
    question: "What is the median salary by title and employment type?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["median_salary"], dimensions: ["title", "employment_type"] },
      chartType: "table",
    },
  },
];

// 018 strand 4/5 (+5): contextual follow-ups (a two-turn inheritance case + a multi-city case), a
// fragmentation case (title grouping), a salary/currency case, and a market-wide scope case. Kept
// non-chart-bearing (no `chartType`) so they exercise tool/mode/params without touching the AC-4 chart
// gate; the verdict/currency/scope correctness is proven in the offline unit + integration suites.
const FOLLOWUP_CASES: EvalCase[] = [
  {
    // Inheritance: "those" = the companies from the prior turn; the follow-up must carry the company
    // grouping forward and ADD only the city, resolving SF -> San Francisco.
    id: "C13",
    question: "How many of those are in SF?",
    context: ["Which companies are hiring the most?"],
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], city: "San Francisco" },
    },
  },
  {
    // Multi-city: one number over both cities via the cities IN-list.
    id: "C14",
    question: "How many job openings are there in LA or NYC?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { cities: ["Los Angeles", "New York"] },
    },
  },
  {
    // Fragmentation: a title grouping (the verdict says "no single role dominates" - proven in unit tests).
    id: "C15",
    question: "Is there one job title that dominates hiring, or is it spread across many?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["count"], dimensions: ["title"] },
    },
  },
  {
    // Salary/currency: a composed salary aggregate (the dominant-currency filter is unit/integration-tested).
    id: "C16",
    question: "What is the median salary by employment type?",
    expect: {
      mode: "data",
      tool: "query_postings",
      params: { measures: ["median_salary"], dimensions: ["employment_type"] },
    },
  },
];

// P2-intent (find-me-a-job / what-fits-me): applying, matching, and personal fit are out of scope, so the
// adviser holds the clarify-path tone in plain mode - no tool, no card. Drawn from the 009 fixture (DRY).
const P2_CASES: EvalCase[] = P2_INTENT_PROMPTS.slice(0, 4).map((question, i) => ({
  id: `P2-${i + 1}`,
  question,
  expect: { mode: "plain", formatRules: true },
}));

// Small talk / definitions / judgement calls: no chart improves the answer, so plain mode, no tool. Drawn
// from the 009 conversational sample (skip index 1, "is now a good time...", the most data-tempting one).
const CONVERSATIONAL_CASES: EvalCase[] = [0, 2, 3, 4].map((idx, i) => ({
  id: `S-${i + 1}`,
  question: CONVERSATIONAL_PROMPTS[idx],
  expect: { mode: "plain", formatRules: true },
}));

// Off-domain for the postings data (weather, a past sports result, a live stock price). 2026-07-21
// vision refinement (answer-anything-then-steer): the agent ANSWERS what it can - a known fact briefly,
// or an honest "I don't fetch that live" (NEVER a fabricated live number) - then steers back to the job
// market. Plain mode, NO tool, NO error card (report_unanswerable is retired from the scope path). The
// strict scorer enforces this: any data tool (a wrong guess) or an old report_unanswerable call fails
// the no-tool expectation.
const OFF_DOMAIN_CASES: EvalCase[] = [
  { id: "U1", question: "What is the weather in San Francisco today?" },
  { id: "U2", question: "Who won the 2022 World Cup?" },
  { id: "U3", question: "What is Google's current stock price?" },
].map((c) => ({
  ...c,
  expect: { mode: "plain", formatRules: true },
}));

export const EVAL_SET: EvalCase[] = [
  ...LAUNCH_CASES,
  ...COMPOSED_CASES,
  ...FOLLOWUP_CASES,
  ...P2_CASES,
  ...CONVERSATIONAL_CASES,
  ...OFF_DOMAIN_CASES,
];

/** The AC-4 chart-bearing sample: every case carrying a RAW chartType expectation (pinned at 12). */
export const CHART_BEARING: EvalCase[] = EVAL_SET.filter((c) => c.expect.chartType !== undefined);
