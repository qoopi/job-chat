import { casePopulation, type EvalCase } from "./eval-set";
import { aggregate, GATE, type ScoredCase } from "./scorer";

// Deterministic reporting (fixed order, no timestamps): a per-case line and the aggregate + gate summary.
// Verbatim from the pre-relocation evals/run.ts. HEAVY is re-exported for the harness header (run.ts).

export const RULE = "-".repeat(96);
export const HEAVY = "=".repeat(96);
const flag = (v: boolean | undefined) =>
  v === undefined ? "--" : v ? "ok" : "XX";
const pct = (n: number, d: number) =>
  d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function printCase(index: number, evalCase: EvalCase, s: ScoredCase): void {
  const idx = String(index).padStart(2, "0");
  const headline = s.toolModePass ? "PASS" : "FAIL";
  const chartCol = s.chartBearing ? ` chart=${flag(s.chartPass)}` : "";
  console.log(
    `[${idx}] ${evalCase.id.padEnd(4)} ${headline}  tool=${flag(s.toolPass)} mode=${flag(s.modePass)}${chartCol}  "${truncate(evalCase.question, 62)}"`,
  );
  const expBits = [
    `mode=${evalCase.expect.mode}`,
    `tool=${evalCase.expect.tool ?? "(none)"}`,
    evalCase.expect.chartType ? `chart=${evalCase.expect.chartType}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const actBits = [
    `mode=${s.observedMode}`,
    `tools=[${s.observedTools.join(",") || "(none)"}]`,
    s.rawChartType ? `chart=${s.rawChartType}` : "",
    `params=${flag(s.paramsPass)}`,
    `format=${flag(s.formatPass)}`,
    s.error ? `ERROR=${truncate(s.error, 60)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(`        exp: ${expBits}`);
  console.log(`        act: ${actBits}`);
}

export function printReport(scored: ScoredCase[]): void {
  const agg = aggregate(scored);
  const ac7 = agg.toolModePass / agg.total >= GATE;
  const ac4 = agg.chartTotal > 0 && agg.chartPass / agg.chartTotal >= GATE;

  console.log(RULE);
  console.log(`AGGREGATE`);
  console.log(
    `  tool+mode : ${agg.toolModePass}/${agg.total}  (${pct(agg.toolModePass, agg.total)})   AC-7 gate >= 90% : ${ac7 ? "PASS" : "FAIL"}`,
  );
  console.log(
    `    - tool  : ${agg.toolPass}/${agg.total}  (${pct(agg.toolPass, agg.total)})`,
  );
  console.log(
    `    - mode  : ${agg.modePass}/${agg.total}  (${pct(agg.modePass, agg.total)})`,
  );
  console.log(
    `  chart-pick: ${agg.chartPass}/${agg.chartTotal}  (${pct(agg.chartPass, agg.chartTotal)})   AC-4 gate >= 90% : ${ac4 ? "PASS" : "FAIL"}   (chart-bearing cases only)`,
  );
  console.log(
    `  params    : ${agg.paramsPass}/${agg.paramsTotal}  (${pct(agg.paramsPass, agg.paramsTotal)})   (informational; subset match on the expected tool call)`,
  );
  console.log(
    `  format    : ${agg.formatPass}/${agg.formatTotal}  (${pct(agg.formatPass, agg.formatTotal)})   (informational; AC-5 tone gate is the offline vitest test)`,
  );
  console.log(
    `  scope     : ${agg.scopePass}/${agg.scopeTotal}  (${pct(agg.scopePass, agg.scopeTotal)})   (informational; 018 strand 5 market-wide scope qualification)`,
  );
  console.log(`  errors    : ${agg.errors} case(s) hit a runtime/model error`);

  // Per-population gate (AC-14 is read PER-POPULATION, never the masking aggregate): the unchanged
  // BASELINE (all non-profile cases) must hold >= total-1 tool+mode (34/35 on the full set), the 12
  // charts all pass, and the REVISED P2 + NEW PROFILE subsets each pass in full.
  const tm = (arr: ScoredCase[]) => arr.filter((s) => s.toolModePass).length;
  const baseline = scored.filter((s) => casePopulation(s.id) === "baseline");
  const p2 = scored.filter((s) => casePopulation(s.id) === "p2-revised");
  const profile = scored.filter((s) => casePopulation(s.id) === "profile");
  const unchanged = [...baseline, ...p2]; // the AC-14 "unchanged/baseline" population
  const unchangedPass = tm(unchanged) >= unchanged.length - 1; // at most one regression among the 35
  const chartsPass = agg.chartTotal > 0 && agg.chartPass === agg.chartTotal;
  const p2Pass = tm(p2) === p2.length;
  const profilePass = tm(profile) === profile.length;
  const ac14 = unchangedPass && chartsPass && p2Pass && profilePass;
  console.log(RULE);
  console.log(`PER-POPULATION (AC-14 exit gate)`);
  console.log(
    `  unchanged/baseline : ${tm(unchanged)}/${unchanged.length} tool+mode   gate >= ${Math.max(unchanged.length - 1, 0)}/${unchanged.length} : ${unchangedPass ? "PASS" : "FAIL"}   (of which true-baseline ${tm(baseline)}/${baseline.length})`,
  );
  console.log(
    `  charts             : ${agg.chartPass}/${agg.chartTotal}   gate all : ${chartsPass ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  revised P2         : ${tm(p2)}/${p2.length} tool+mode   gate all : ${p2Pass ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  new profile        : ${tm(profile)}/${profile.length} tool+mode   gate all : ${profilePass ? "PASS" : "FAIL"}`,
  );
  console.log(`  AC-14 (all populations) : ${ac14 ? "PASS" : "FAIL"}`);

  const failures = scored.filter(
    (s) => !s.toolModePass || (s.chartBearing && s.chartPass === false),
  );
  console.log(RULE);
  console.log(`FAILURES (tool+mode or chart): ${failures.length}`);
  for (const s of failures) {
    const reasons: string[] = [];
    if (!s.toolModePass)
      reasons.push(
        `tool+mode expected ok, got tools=[${s.observedTools.join(",") || "(none)"}] mode=${s.observedMode}`,
      );
    if (s.chartBearing && s.chartPass === false)
      reasons.push(`chart expected pick, got ${s.rawChartType ?? "(none)"}`);
    if (s.error) reasons.push(`error: ${s.error}`);
    console.log(`  [${s.id}] ${reasons.join("; ")}`);
  }
  console.log(HEAVY);
  console.log(
    `RESULT  AC-7(tool+mode)=${ac7 ? "PASS" : "FAIL"} ${agg.toolModePass}/${agg.total}  AC-4(chart)=${ac4 ? "PASS" : "FAIL"} ${agg.chartPass}/${agg.chartTotal}`,
  );
  console.log(HEAVY);
}
