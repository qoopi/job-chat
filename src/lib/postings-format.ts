import type { ScoredPostingRow } from "@shared/insight";
import { isSeniorPlusBand } from "@shared/analytics";
import { formatMoney } from "@/lib/insight-format";

export const POSTINGS_INCHAT_CAP = 8;

/** The salary cell: a range/bound in whole-k, or "not listed" (never blank). No currency on the row, so default base. */
export function salaryLabel(row: Pick<ScoredPostingRow, "salaryMin" | "salaryMax">): string {
  const { salaryMin, salaryMax } = row;
  if (salaryMin == null && salaryMax == null) return "not listed";
  if (salaryMin != null && salaryMax != null) return `${formatMoney(salaryMin)}–${formatMoney(salaryMax)}`;
  return formatMoney((salaryMin ?? salaryMax)!);
}

export function locationLabel(row: Pick<ScoredPostingRow, "remote" | "city">): string {
  if (row.remote) return "Remote";
  return row.city ?? "—";
}

export function hasSalary(row: Pick<ScoredPostingRow, "salaryMin" | "salaryMax">): boolean {
  return row.salaryMin != null || row.salaryMax != null;
}

export function isSeniorPlus(row: Pick<ScoredPostingRow, "experience">): boolean {
  return isSeniorPlusBand(row.experience);
}

export function shownCount(rows: ScoredPostingRow[]): number {
  return Math.min(rows.length, POSTINGS_INCHAT_CAP);
}

/** Corpus-honesty caption: the company with the most matches + its COMPUTED share. Null on too few rows or
 *  a tie (no plurality). Derived, never hardcoded. */
export function corpusHonesty(rows: ScoredPostingRow[]): { company: string; share: number } | null {
  if (rows.length < 2) return null;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.company, (counts.get(r.company) ?? 0) + 1);
  let top = "";
  let topCount = 0;
  let tie = false;
  for (const [company, count] of counts) {
    if (count > topCount) {
      top = company;
      topCount = count;
      tie = false;
    } else if (count === topCount) {
      tie = true;
    }
  }
  if (tie || topCount < 2) return null;
  return { company: top, share: Math.round((topCount / rows.length) * 100) };
}

export function postingsVerdict(total: number, shown: number): string {
  if (shown >= total) return `${total} postings match your profile.`;
  return `${total} postings match your profile — showing the best ${shown}.`;
}

/** The NEUTRAL header for a latest_postings list (not a profile fit): no "match your profile", no best-by-score
 *  framing - rows are ordered by recency, so it reads "showing the latest N". */
export function latestPostingsVerdict(total: number, shown: number): string {
  if (shown >= total) return `${total} postings.`;
  return `${total} postings — showing the latest ${shown}.`;
}

/** The postings emitter hard cap (mergeSearchParams mirrors this 50); the part carries ALL matches up to it. */
export const POSTINGS_ROWS_CAP = 50;

/** The "Open in panel" chip label - honest about what the panel actually holds: when rowsShown covers the whole
 *  set the panel IS complete ("Open all {total}"); otherwise it is truncated, so the chip reads "Open top {rowsShown} of {total}". */
export function openPanelLabel(rowsShown: number, total: number): string {
  if (rowsShown >= total) return `Open all ${total}`;
  return `Open top ${rowsShown} of ${total}`;
}
