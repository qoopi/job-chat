import { ADVISER_V2 } from "../../trigger/prompts/adviser-v2";
import { EVAL_SET } from "./eval-set";
import {
  assertEvalEnabled,
  bedrockStreamModel,
  buildModel,
  MODEL_ID,
  runCase,
  selectEvalCases,
} from "./runner";
import { scoreCase, type ScoredCase } from "./scorer";
import { HEAVY, printCase, printReport } from "./report";

// The eval harness entry point (dev tooling; NOT a vitest test - tests/evals/ sits outside the vitest
// globs). It wires the shipped prompt + the live Bedrock model seam into the runner, drives each selected
// case, and prints the deterministic report. Cost: ~one agent turn per case, on-demand only; guarded by
// JOBCHAT_EVAL=1 so it can never run in CI or by accident. Run with `JOBCHAT_EVAL=1 bun run eval`; scope
// a spot-check with `JOBCHAT_EVAL_IDS=Q1,C1 ...` (see selectEvalCases).

async function main(): Promise<void> {
  try {
    assertEvalEnabled();
  } catch (err) {
    console.error(`[eval] ${(err as Error).message}`);
    console.error(`[eval] nothing ran, no Bedrock calls made.`);
    process.exit(1);
  }

  const system = ADVISER_V2; // the shipped prompt (trigger/chat.ts wires it)
  const streamModel = bedrockStreamModel(buildModel());

  const { cases, skipped } = selectEvalCases(EVAL_SET, process.env.JOBCHAT_EVAL_IDS);
  const chartBearing = cases.filter((c) => c.expect.chartType !== undefined).length;

  console.log(HEAVY);
  console.log(`Job.Chat eval harness  |  model=${MODEL_ID}`);
  console.log(`${cases.length} cases  |  ${chartBearing} chart-bearing (AC-4 sample)`);
  if (skipped > 0)
    console.log(
      `JOBCHAT_EVAL_IDS filter: running ${cases.length} of ${EVAL_SET.length} cases (${skipped} skipped)`,
    );
  console.log(HEAVY);

  if (cases.length === 0) {
    console.error(`[eval] JOBCHAT_EVAL_IDS matched no cases - nothing to run.`);
    process.exit(1);
  }

  const scored: ScoredCase[] = [];
  for (let i = 0; i < cases.length; i++) {
    const observed = await runCase(streamModel, system, cases[i]);
    const s = scoreCase(cases[i], observed);
    scored.push(s);
    printCase(i + 1, cases[i], s);
  }
  printReport(scored);
}

if ((import.meta as { main?: boolean }).main === true) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
