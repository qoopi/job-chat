import type { DataPoint } from "@shared/insight";

// Pure presentation helpers for the insight surfaces. Kept free of React/"use client" so the copy
// contracts (AC-10) and the chart series-reading conventions are unit-testable in isolation.

/** The error taxonomy the agent tags (mirrors trigger/parts.ts AgentErrorKind - UI copy layer). */
export type ErrorKind = "system" | "unanswerable";
/** The refusal taxonomy (mirrors trigger/parts.ts RefusalPartReason - UI copy layer): the cap/budget
 *  guard plus `too_long` for an over-length turn refused at the agent-run ingress. */
export type RefusalReason = "guest_cap" | "daily_budget" | "too_long";

/** AC-10: distinct copy for a system failure vs an unanswerable question. Never a raw error. */
export function errorCopy(kind: ErrorKind): string {
  return kind === "system"
    ? "Something went wrong on my side - try again"
    : "I could not answer that - try rephrasing";
}

/** AC-15/AC-20: a polite limit notice (not an error) shown until the auth dialog exists. `too_long`
 *  is the agent-run input-size backstop (a payload past MAX_INPUT_CHARS reaching `.in` directly). */
export function refusalCopy(reason: RefusalReason): string {
  if (reason === "guest_cap") return "You have reached the guest message limit. Sign in to keep going.";
  if (reason === "too_long") return "That message is too long. Please shorten it and try again.";
  return "The service has reached today's message limit. Try again tomorrow.";
}

/** Money for verdicts and axes: whole thousands read as $Nk, smaller values in full. */
export function formatUsd(value: number): string {
  const n = Math.round(value);
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}

/**
 * Data-freshness label ("just now" / "5m ago" / "3h ago" / "2d ago") from a ClickHouse timestamp.
 * Returns "" when the timestamp is unparseable OR clearly a placeholder (pre-2000): `max(ingested_at)`
 * over an EMPTY result set comes back as the 1970 epoch, which must never render as "20654d ago". The
 * source line is also suppressed entirely when sampleN is 0 (see InsightCard) - this is the second line
 * of defense so any pre-2000 timestamp is dropped even where a count is shown.
 */
export function freshnessLabel(chTs: string): string {
  const parsed = Date.parse(chTs.includes("T") ? chTs : `${chTs.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return "";
  if (parsed < Date.UTC(2000, 0, 1)) return ""; // epoch / placeholder over 0 rows
  const mins = Math.round((Date.now() - parsed) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function isNumeric(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** The label column: the first key whose value is a string (company, city, day, label...). */
export function labelKeyOf(rows: DataPoint[]): string {
  const first = rows[0] ?? {};
  const key = Object.keys(first).find((k) => typeof first[k] === "string");
  return key ?? Object.keys(first)[0] ?? "label";
}

/** Every numeric measure column, in row order, excluding the label (grouped-bars support). */
export function valueKeysOf(rows: DataPoint[], labelKey: string): string[] {
  const first = rows[0] ?? {};
  return Object.keys(first).filter((k) => k !== labelKey && isNumeric(first[k]));
}

// When a row carries several measures (e.g. {median, n}) the headline one wins; a bare {label, count}
// falls through to its single measure.
const MEASURE_PRIORITY = ["median", "value", "amount", "total", "count", "n"];

/** The single measure a one-series chart plots: the highest-priority numeric column present. */
export function valueKeyOf(rows: DataPoint[], labelKey: string): string {
  const keys = valueKeysOf(rows, labelKey);
  const preferred = MEASURE_PRIORITY.find((p) => keys.includes(p));
  return preferred ?? keys[0] ?? "value";
}

// The headline number token: money ($182k), percent (46%), or grouped count (1,204). The verdict card
// wraps this in <b> (weight 700, 1.14em) so the number is the hero, wherever it sits in the sentence.
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?%?k?/;

/** Split a verdict into [before, number, after] around its first number token, or null if none. */
export function splitFirstNumber(text: string): [string, string, string] | null {
  const m = text.match(NUMBER_RE);
  if (!m || m.index === undefined) return null;
  return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
}
