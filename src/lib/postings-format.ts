import type { ScoredPostingRow } from "@shared/insight";
import { formatMoney } from "@/lib/insight-format";

// Pure presentation helpers for the postings card + its LCP full list. Kept free of React so the
// table-cell contracts (a missing salary reads "not listed", never blank), the corpus-honesty share
// (computed, never hardcoded), and the filter counts are unit-testable in isolation.

/** Cap the in-chat table at 8 rows; the full list lives in the LCP. */
export const POSTINGS_INCHAT_CAP = 8;

/** The salary cell: a range (or single bound) in whole-k, or the muted "not listed" when neither bound
 *  is known - never blank. Currency isn't carried on the row, so amounts format in the default base. */
export function salaryLabel(row: Pick<ScoredPostingRow, "salaryMin" | "salaryMax">): string {
  const { salaryMin, salaryMax } = row;
  if (salaryMin == null && salaryMax == null) return "not listed";
  if (salaryMin != null && salaryMax != null) return `${formatMoney(salaryMin)}–${formatMoney(salaryMax)}`;
  return formatMoney((salaryMin ?? salaryMax)!);
}

/** The location cell: "Remote" for a remote role, else the city (or a dash when the city is unknown). */
export function locationLabel(row: Pick<ScoredPostingRow, "remote" | "city">): string {
  if (row.remote) return "Remote";
  return row.city ?? "—";
}

/** True while the salary cell would show "not listed" (used by the "With salary" filter). */
export function hasSalary(row: Pick<ScoredPostingRow, "salaryMin" | "salaryMax">): boolean {
  return row.salaryMin != null || row.salaryMax != null;
}

/** Senior-or-above by the row's free-text experience level (used by the "Senior+" filter). */
export function isSeniorPlus(row: Pick<ScoredPostingRow, "experience">): boolean {
  return /senior|staff|lead|principal|director/i.test(row.experience);
}

/** How many rows the in-chat card shows (capped). */
export function shownCount(rows: ScoredPostingRow[]): number {
  return Math.min(rows.length, POSTINGS_INCHAT_CAP);
}

/**
 * The corpus-honesty caption datum: the single company that posts the most of these matches, plus its
 * COMPUTED percentage share of them. Null when there are too few rows to make an honest claim, or when
 * no company holds a plurality (a tie has no "most matches"). "Order IS the rank" - this is the only
 * aggregate the card states, and it is derived, never hardcoded.
 */
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

/** The postings verdict sentence (its first number - the total - is bolded by the card). */
export function postingsVerdict(total: number, shown: number): string {
  if (shown >= total) return `${total} postings match your profile.`;
  return `${total} postings match your profile — showing the best ${shown}.`;
}

/** The postings part's emitter hard cap (trigger/tools.ts's `mergeSearchParams` mirrors this same 50 -
 *  the inherited 029-review contract: the part carries ALL matching rows up to this cap). */
export const POSTINGS_ROWS_CAP = 50;

/**
 * The "Open ... in panel" chip label - the ONE home for the rows-cap-50 honesty contract: when
 * `total` is within the emitter's hard cap, `rows` genuinely IS the complete matched set, so "Open all
 * {total}" is literal; when `total` exceeds the cap, the emitter truncated to the top-`rowsShown` rows,
 * so the chip must not claim "all" - it reads "Open top {rowsShown} of {total}" instead.
 */
export function openPanelLabel(rowsShown: number, total: number): string {
  if (total > POSTINGS_ROWS_CAP) return `Open top ${rowsShown} of ${total}`;
  return `Open all ${total}`;
}
