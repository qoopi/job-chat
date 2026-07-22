import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { casePopulation, type EvalCase } from "./eval-set";
import type { Observed } from "./runner";
import { aggregate, type ScoredCase } from "./scorer";

// Per-case transcript persistence for the eval runner. One JSONL line per scored case - the OBSERVED tool
// calls (name + input params), answer mode, rendered-card flag, the pinned expectation, the deterministic
// verdict, and the AC-14 population - plus a trailing summary line (model, timestamp, per-population
// tallies). Written under the Playbook's tracker/research/ so a later gate claim ("the model answered X")
// is auditable against the record rather than trusted. Dev tooling; the live runner calls it once per run.

export interface TranscriptRecord {
  evalCase: EvalCase;
  observed: Observed;
  scored: ScoredCase;
}

function caseLine(rec: TranscriptRecord): Record<string, unknown> {
  const { evalCase, observed, scored } = rec;
  return {
    id: evalCase.id,
    population: casePopulation(evalCase.id),
    question: evalCase.question,
    context: evalCase.context ?? null,
    // Identity WITHOUT the raw profile (which never leaves the server): just the flags that shape routing.
    identity: evalCase.identity
      ? { signedIn: evalCase.identity.signedIn, hasProfile: Boolean(evalCase.identity.profile) }
      : null,
    expect: {
      mode: evalCase.expect.mode,
      tool: evalCase.expect.tool ?? null,
      params: evalCase.expect.params ?? null,
      chartType: evalCase.expect.chartType ?? null,
    },
    observed: {
      mode: scored.observedMode,
      tools: observed.toolCalls, // [{ name, input }] - the actual params the model passed
      rawChartType: scored.rawChartType ?? null,
      renderedCard: observed.renderedCard,
      text: observed.text,
      error: observed.error ?? null,
    },
    verdict: {
      toolPass: scored.toolPass,
      modePass: scored.modePass,
      toolModePass: scored.toolModePass,
      chartBearing: scored.chartBearing,
      chartPass: scored.chartPass ?? null,
      paramsPass: scored.paramsPass ?? null,
      formatPass: scored.formatPass ?? null,
      scopePass: scored.scopePass ?? null,
    },
  };
}

function summaryLine(records: TranscriptRecord[], model: string): Record<string, unknown> {
  const scored = records.map((r) => r.scored);
  const byPop = (pop: string) => scored.filter((s) => casePopulation(s.id) === pop);
  const tm = (arr: ScoredCase[]) => arr.filter((s) => s.toolModePass).length;
  const baseline = byPop("baseline");
  const p2 = byPop("p2-revised");
  const profile = byPop("profile");
  const unchanged = [...baseline, ...p2]; // the AC-14 "unchanged/baseline" population (all non-profile)
  const agg = aggregate(scored);
  return {
    summary: true,
    model,
    timestamp: new Date().toISOString(),
    total: scored.length,
    aggregate: { toolModePass: agg.toolModePass, total: agg.total },
    // Per-population, the way AC-14's exit gate is read (not the masking aggregate).
    populations: {
      unchanged: { toolModePass: tm(unchanged), total: unchanged.length, gate: ">= total-1 (34/35)" },
      baseline: { toolModePass: tm(baseline), total: baseline.length },
      p2Revised: { toolModePass: tm(p2), total: p2.length, gate: "all" },
      profile: { toolModePass: tm(profile), total: profile.length, gate: "all" },
    },
    charts: { pass: agg.chartPass, total: agg.chartTotal, gate: "all (12/12)" },
  };
}

/**
 * Write the per-case transcript (one JSON object per line) plus a trailing summary line, and return the
 * absolute path. Lands under the Playbook's tracker/research/ as eval-transcript-<YYYY-MM-DD>.jsonl -
 * resolved relative to this file so it is independent of the process cwd.
 */
export function writeEvalTranscript(records: TranscriptRecord[], model: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // tests/evals
  const dir = path.resolve(here, "../../../Job.Chat.Playbook/tracker/research");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `eval-transcript-${date}.jsonl`);
  const lines = [
    ...records.map((r) => JSON.stringify(caseLine(r))),
    JSON.stringify(summaryLine(records, model)),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}
