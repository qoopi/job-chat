import type { DataInsight, DataPoint, ErrorKind, RefusalReason } from "@shared/insight";
import { labelKeyOf } from "@shared/insight";

export type { ErrorKind, RefusalReason };

export { labelKeyOf };

// Cap visible bars: many long near-unique titles smear into an unreadable stack; beyond this, top N + a "+ N more" detail panel affordance.
export const BARS_CAP = 8;

/** Truncate a long category label for the chart axis (the full label rides in the data + tooltip). */
export function truncateLabel(label: string, max = 26): string {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

/** A single-scalar answer (one-row, one-cell table): rendered as the verdict sentence alone (a one-cell card is degenerate). */
export function isSingleScalar(insight: DataInsight): boolean {
  return (
    insight.kind === "table" &&
    insight.rows.length === 1 &&
    Object.keys(insight.rows[0]).length === 1
  );
}

/** Bars shown when a bars chart is capped top-N (BARS_CAP), else null - so the source line can disclose "showing top N". */
export function barsChartCapsAt(insight: DataInsight): number | null {
  if (insight.kind !== "chart" || insight.chartType !== "bars") return null;
  const labelKey = labelKeyOf(insight.series);
  if (valueKeysOf(insight.series, labelKey).length > 1) return null; // grouped bars are not capped
  return insight.series.length > BARS_CAP ? BARS_CAP : null;
}

export function errorCopy(kind: ErrorKind): string {
  return kind === "system"
    ? "Something went wrong on my side - try again"
    : "I could not answer that - try rephrasing";
}

export function refusalCopy(reason: RefusalReason): string {
  if (reason === "guest_cap")
    return "You have reached the guest message limit. Sign in to keep going.";
  if (reason === "too_long")
    return "That message is too long. Please shorten it and try again.";
  return "The service has reached today's message limit. Try again tomorrow.";
}

// Currency symbols; anything else prefixes its ISO code ("CHF 180k") so an amount is never mislabeled with a "$".
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CAD: "$",
  AUD: "$",
};

/** Money: whole thousands as <sym>Nk, smaller in full. Defaults to USD; a salary insight passes its real currency. */
export function formatMoney(value: number, currency = "USD"): string {
  const n = Math.round(value);
  const prefix = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  if (Math.abs(n) >= 1000) return `${prefix}${Math.round(n / 1000)}k`;
  return `${prefix}${n}`;
}

/** Data-freshness label from a ClickHouse timestamp; "" when unparseable or pre-2000, because max(ingested_at)
 *  over an EMPTY result set is the 1970 epoch (must never render as "20654d ago"). */
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

// `n` is a SAMPLE-SIZE context column, never a series to plot (a count beside a median would be a misleading second bar).
const CONTEXT_KEYS = new Set(["n"]);

export function valueKeysOf(rows: DataPoint[], labelKey: string): string[] {
  const first = rows[0] ?? {};
  return Object.keys(first).filter(
    (k) => k !== labelKey && !CONTEXT_KEYS.has(k) && isNumeric(first[k]),
  );
}

// When a row carries several measures the headline one wins; a bare {label, count} falls through to its single measure.
const MEASURE_PRIORITY = ["median", "value", "amount", "total", "count"];

export function valueKeyOf(rows: DataPoint[], labelKey: string): string {
  const keys = valueKeysOf(rows, labelKey);
  const preferred = MEASURE_PRIORITY.find((p) => keys.includes(p));
  return preferred ?? keys[0] ?? "value";
}

// The headline number token (money/percent/count); the verdict card wraps it in <b> so the number is the hero.
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?%?k?/;

export function splitFirstNumber(
  text: string,
): [string, string, string] | null {
  const m = text.match(NUMBER_RE);
  if (!m || m.index === undefined) return null;
  return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
}
