import type { DataInsight, DataPoint, ErrorKind, RefusalReason } from "@shared/insight";

// The error / refusal taxonomy lives in `@shared/insight` (its one home); re-exported here so the UI copy
// helpers and their callers keep importing the kinds from the insight-format layer.
export type { ErrorKind, RefusalReason };

// Pure presentation helpers for the insight surfaces. Kept free of React/"use client" so the copy
// contracts (AC-10) and the chart series-reading conventions are unit-testable in isolation.

// refresh #2 s2: a single-measure ("vertical") bar chart of many long, near-unique titles used to smear
// its category labels into an unreadable stack. The fix caps the visible bars at this count; more than
// this renders the top N plus a "+ N more" affordance into the LCP table.
export const BARS_CAP = 8;

/** Truncate a long category label for the chart axis (the full label rides in the data + tooltip). */
export function truncateLabel(label: string, max = 26): string {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

/**
 * AC-18: a single-scalar answer - a one-row, one-cell table whose only content is the number the
 * verdict already states (a no-dimension single-measure query: `{ count: N }`, `{ median_salary: N }`).
 * Rendered as the verdict sentence alone: a one-cell table card is degenerate. Charts and multi-cell
 * tables are never scalars.
 */
export function isSingleScalar(insight: DataInsight): boolean {
  return (
    insight.kind === "table" &&
    insight.rows.length === 1 &&
    Object.keys(insight.rows[0]).length === 1
  );
}

/**
 * When a bars insight renders as a capped top-N vertical chart, the number of bars shown (BARS_CAP);
 * null otherwise (grouped/multi-measure bars, a non-bars chart, or a series at/under BARS_CAP). Lets the
 * source line disclose "showing top N" in agreement with the chart, never letting the visible slice pose
 * as the whole market (refresh #2 s3-consistency).
 */
export function barsChartCapsAt(insight: DataInsight): number | null {
  if (insight.kind !== "chart" || insight.chartType !== "bars") return null;
  const labelKey = labelKeyOf(insight.series);
  if (valueKeysOf(insight.series, labelKey).length > 1) return null; // grouped bars are not capped
  return insight.series.length > BARS_CAP ? BARS_CAP : null;
}

/** AC-10: distinct copy for a system failure vs an unanswerable question. Never a raw error. */
export function errorCopy(kind: ErrorKind): string {
  return kind === "system"
    ? "Something went wrong on my side - try again"
    : "I could not answer that - try rephrasing";
}

/** AC-15/AC-20: a polite limit notice (not an error) shown until the auth dialog exists. `too_long`
 *  is the agent-run input-size backstop (a payload past MAX_INPUT_CHARS reaching `.in` directly). */
export function refusalCopy(reason: RefusalReason): string {
  if (reason === "guest_cap")
    return "You have reached the guest message limit. Sign in to keep going.";
  if (reason === "too_long")
    return "That message is too long. Please shorten it and try again.";
  return "The service has reached today's message limit. Try again tomorrow.";
}

// Symbols for the currencies the corpus is likely to carry; anything else prefixes its ISO code
// ("CHF 180k"), so the amount is never mislabeled with a "$" it is not in (018 strand 3).
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CAD: "$",
  AUD: "$",
};

/** Money for tables and axes: whole thousands read as <sym>Nk, smaller values in full. Defaults to USD
 *  so existing callers are unchanged; a salary insight passes the real currency it was filtered to. */
export function formatMoney(value: number, currency = "USD"): string {
  const n = Math.round(value);
  const prefix = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  if (Math.abs(n) >= 1000) return `${prefix}${Math.round(n / 1000)}k`;
  return `${prefix}${n}`;
}

/** The USD-pinned money formatter (the salary histogram is inherently one currency). */
export function formatUsd(value: number): string {
  return formatMoney(value, "USD");
}

/**
 * Data-freshness label ("just now" / "5m ago" / "3h ago" / "2d ago") from a ClickHouse timestamp.
 * Returns "" when the timestamp is unparseable OR clearly a placeholder (pre-2000): `max(ingested_at)`
 * over an EMPTY result set comes back as the 1970 epoch, which must never render as "20654d ago". The
 * source line is also suppressed entirely when sampleN is 0 (see InsightCard) - this is the second line
 * of defense so any pre-2000 timestamp is dropped even where a count is shown.
 */
export function freshnessLabel(chTs: string): string {
  const parsed = Date.parse(
    chTs.includes("T") ? chTs : `${chTs.replace(" ", "T")}Z`,
  );
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

// `n` is a SAMPLE-SIZE context column (salary_compare returns {city, median, n}), never a series to
// plot - a count of ~3 beside a median of ~180000 would be an invisible, misleading second bar. Excluded
// from the plottable measures so BarsChart never renders it as a grouped series (018 strand 3).
const CONTEXT_KEYS = new Set(["n"]);

/** Every numeric measure column, in row order, excluding the label and sample-size context (`n`). */
export function valueKeysOf(rows: DataPoint[], labelKey: string): string[] {
  const first = rows[0] ?? {};
  return Object.keys(first).filter(
    (k) => k !== labelKey && !CONTEXT_KEYS.has(k) && isNumeric(first[k]),
  );
}

// When a row carries several measures (e.g. {median, n}) the headline one wins; a bare {label, count}
// falls through to its single measure. (`n` is excluded from the plottable set above.)
const MEASURE_PRIORITY = ["median", "value", "amount", "total", "count"];

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
export function splitFirstNumber(
  text: string,
): [string, string, string] | null {
  const m = text.match(NUMBER_RE);
  if (!m || m.index === undefined) return null;
  return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
}
