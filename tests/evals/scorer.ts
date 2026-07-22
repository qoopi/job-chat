import { CATALOG_TOOL_NAMES } from "../../trigger/tools";
import {
  countSentences,
  startsWithBannedOpener,
} from "../fixtures/plain-prompts";
import type { EvalCase, EvalExpect, EvalMode } from "./eval-set";
import type { Observed } from "./runner";

// The pure, deterministic scorer: it judges the agent's CHOICES (tool, mode, raw chart pick, params,
// format, scope) against a case's pinned expectations, and aggregates them into the pass gates.
// No timestamps, fixed order - reproducible.

export interface ScoredCase {
  id: string;
  observedMode: EvalMode;
  observedTools: string[];
  rawChartType?: string;
  toolPass: boolean;
  modePass: boolean;
  toolModePass: boolean; // the tool+mode unit
  chartBearing: boolean;
  chartPass?: boolean; // chart-bearing cases only
  paramsChecked: boolean;
  paramsPass?: boolean;
  formatChecked: boolean;
  formatPass?: boolean;
  scopeChecked: boolean;
  scopePass?: boolean;
  error?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function sameSet(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
  const bn = b.map(norm);
  return a.every((x) => bn.includes(norm(x)));
}

/** SUBSET match: every expected key present in the actual input with an equal value (never exact-object). */
function paramsSubsetMatch(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, exp]) => {
    const act = actual[key];
    if (Array.isArray(exp)) return Array.isArray(act) && sameSet(exp, act);
    if (typeof exp === "string" && typeof act === "string")
      return exp.toLowerCase() === act.toLowerCase();
    return act === exp;
  });
}

// The data tools whose call renders an insight card: the 6 fixed templates + the composed query_postings.
// A second data tool means a second card - a defect under P1's "one answer, one card" contract - so a
// data-tool expectation must be met by EXACTLY that tool, called once, with no other data tool alongside.
const DATA_TOOLS = new Set<string>([...CATALOG_TOOL_NAMES, "query_postings"]);

// The tool+mode gate asks the agent to "select THE expected tool and mode" (definite article, singular). For a data tool
// that means the expected tool called EXACTLY once and NO other data tool: a right tool called beside an
// extra data tool emits a second card - a defect, not a pass (the saved v1 Q5 hit this: share_split +
// query_postings). The pure-plain (no-tool) and report_unanswerable cases are excepted - plain expects
// zero tools, and report_unanswerable (not a data tool) keeps the lenient membership check as before.
function toolMatches(expect: EvalExpect, observedTools: string[]): boolean {
  if (expect.tool === undefined) return observedTools.length === 0; // a pure plain answer calls no tool
  if (!DATA_TOOLS.has(expect.tool)) return observedTools.includes(expect.tool); // report_unanswerable
  const expectedCalls = observedTools.filter((t) => t === expect.tool).length;
  const extraDataTool = observedTools.some(
    (t) => t !== expect.tool && DATA_TOOLS.has(t),
  );
  return expectedCalls === 1 && !extraDataTool;
}

function formatOk(text: string): boolean {
  return (
    countSentences(text) <= 2 &&
    !text.includes("!") &&
    !startsWithBannedOpener(text)
  );
}

// Informational: a scope-qualified answer names the sample / its dominance rather than
// presenting the corpus as the whole market. Heuristic over the answer text - never gates a run.
function scopeQualifiedOk(text: string): boolean {
  return /\bsample\b|\bmostly\b|\bgoogle\b|\balphabet\b|dominat|one (company|employer)|not.*(representative|whole|entire|full)/i.test(
    text,
  );
}

export function scoreCase(evalCase: EvalCase, observed: Observed): ScoredCase {
  const { expect } = evalCase;
  const observedTools = observed.toolCalls.map((t) => t.name);
  const observedMode: EvalMode = observed.hasInsight ? "data" : "plain";
  const modePass = observedMode === expect.mode;
  const toolPass = toolMatches(expect, observedTools);

  const composedCall = observed.toolCalls.find(
    (t) => t.name === "query_postings",
  );
  const rawChartType = composedCall
    ? asString(composedCall.input.chartType)
    : undefined;
  const chartBearing = expect.chartType !== undefined;

  const expectedCall = expect.tool
    ? observed.toolCalls.find((t) => t.name === expect.tool)
    : undefined;
  const paramsChecked = Boolean(expect.params && expectedCall);

  return {
    id: evalCase.id,
    observedMode,
    observedTools,
    rawChartType,
    toolPass,
    modePass,
    toolModePass: toolPass && modePass,
    chartBearing,
    chartPass: chartBearing ? rawChartType === expect.chartType : undefined,
    paramsChecked,
    paramsPass: paramsChecked
      ? paramsSubsetMatch(expect.params!, expectedCall!.input)
      : undefined,
    formatChecked: Boolean(expect.formatRules),
    formatPass: expect.formatRules ? formatOk(observed.text) : undefined,
    scopeChecked: Boolean(expect.scopeQualified),
    scopePass: expect.scopeQualified
      ? scopeQualifiedOk(observed.text)
      : undefined,
    error: observed.error,
  };
}

// ---- aggregate + gates --------------------------------------------------------------------------

export const GATE = 0.9;

export interface Aggregate {
  total: number;
  toolModePass: number;
  toolPass: number;
  modePass: number;
  chartTotal: number;
  chartPass: number;
  paramsTotal: number;
  paramsPass: number;
  formatTotal: number;
  formatPass: number;
  scopeTotal: number;
  scopePass: number;
  errors: number;
}

export function aggregate(scored: ScoredCase[]): Aggregate {
  const count = (pred: (s: ScoredCase) => boolean) =>
    scored.filter(pred).length;
  return {
    total: scored.length,
    toolModePass: count((s) => s.toolModePass),
    toolPass: count((s) => s.toolPass),
    modePass: count((s) => s.modePass),
    chartTotal: count((s) => s.chartBearing),
    chartPass: count((s) => s.chartBearing && s.chartPass === true),
    paramsTotal: count((s) => s.paramsChecked),
    paramsPass: count((s) => s.paramsPass === true),
    formatTotal: count((s) => s.formatChecked),
    formatPass: count((s) => s.formatPass === true),
    scopeTotal: count((s) => s.scopeChecked),
    scopePass: count((s) => s.scopePass === true),
    errors: count((s) => s.error !== undefined),
  };
}
