import type { Page } from "@playwright/test";

// Chunk-script builders for the E2E mock transport (src/lib/mock-transport.ts). Each spec pins the next
// turn's `UIMessageChunk` sequence on `window.__CHAT_SCRIPT__`; the mock replays it as the agent's
// response, so the whole client loop (skeleton reconciliation, stop, retry, refusal) runs against the
// built app with no Trigger.dev / Bedrock. NOT a spec file (no `.spec` suffix) - Playwright ignores it.

export interface ScriptStep {
  chunk: Record<string, unknown>;
  delayMs?: number;
}

// A realistic data answer, shaped like the analytics catalog output (so Show query reveals real SQL).
// Each turn gets a UNIQUE card id (two live cards must not share ARIA ids or a one-shot chip key).
let cardSeq = 0;
export function liveInsight(id = `live-card-${cardSeq++}`) {
  return {
    id,
    kind: "chart",
    chartType: "bars",
    verdict: "Amazon leads hiring with 214 open roles.",
    series: [
      { company: "Amazon", count: 214 },
      { company: "Google", count: 107 },
      { company: "Stripe", count: 96 },
    ],
    followups: ["Only remote roles", "Which roles are they hiring for?"],
    meta: {
      sql: "SELECT company, count() AS count FROM postings FINAL GROUP BY company ORDER BY count DESC LIMIT 10",
      sampleN: 3483,
      updatedAt: "2026-07-18 19:12:00",
    },
  };
}

/** Skeleton first, then (after a beat, so the skeleton is observable) the filled insight (AC-4/8). */
export function insightScript(fillDelayMs = 700): ScriptStep[] {
  const insight = liveInsight();
  const loading = { id: insight.id, kind: "chart", chartType: "bars", status: "loading" };
  return [
    { chunk: { type: "start" } },
    { chunk: { type: "data-insight", id: insight.id, data: loading }, delayMs: 60 },
    { chunk: { type: "data-insight", id: insight.id, data: insight }, delayMs: fillDelayMs },
    { chunk: { type: "finish" } },
  ];
}

/** A partial text answer that hangs mid-sentence, so a spec can Stop before the rest arrives (AC-9). */
export function partialThenHangScript(): ScriptStep[] {
  return [
    { chunk: { type: "start" } },
    { chunk: { type: "text-start", id: "t" }, delayMs: 40 },
    { chunk: { type: "text-delta", id: "t", delta: "The median salary is $182k" }, delayMs: 60 },
    { chunk: { type: "text-delta", id: "t", delta: " and climbing fast." }, delayMs: 10_000 },
    { chunk: { type: "text-end", id: "t" } },
    { chunk: { type: "finish" } },
  ];
}

/** The compact error card (AC-10): kind = "system" | "unanswerable". */
export function errorScript(kind: "system" | "unanswerable"): ScriptStep[] {
  return [
    { chunk: { type: "start" } },
    { chunk: { type: "data-error", id: "err", data: { kind } }, delayMs: 40 },
    { chunk: { type: "finish" } },
  ];
}

/** The polite limit notice (AC-15): reason = "guest_cap" | "daily_budget". */
export function refusalScript(reason: "guest_cap" | "daily_budget"): ScriptStep[] {
  return [
    { chunk: { type: "start" } },
    { chunk: { type: "data-refusal", id: "ref", data: { reason } }, delayMs: 40 },
    { chunk: { type: "finish" } },
  ];
}

/** Pin the script before navigation (persists across the landing -> chat client-side push). */
export async function armScript(page: Page, script: ScriptStep[]): Promise<void> {
  await page.addInitScript((s) => {
    (window as unknown as { __CHAT_SCRIPT__?: unknown }).__CHAT_SCRIPT__ = s;
  }, script);
}

/** Re-pin the script mid-test (e.g. a success answer for a Retry after an error). */
export async function setScript(page: Page, script: ScriptStep[]): Promise<void> {
  await page.evaluate((s) => {
    (window as unknown as { __CHAT_SCRIPT__?: unknown }).__CHAT_SCRIPT__ = s;
  }, script);
}
