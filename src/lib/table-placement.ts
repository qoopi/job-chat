// AC-8 placement rule. Deterministic and CLIENT-side (epic ruling): the agent never decides where a
// table renders, so persisted payloads are untouched and a resumed conversation renders the identical
// preview/LCP. A table of more than LCP_TABLE_THRESHOLD rows becomes a preview card (first
// LCP_TABLE_PREVIEW_ROWS rows) that opens the full table in the Left Chat Part; at or below the
// threshold it renders in full, in-chat. Charts always render in-chat (this rule is table-only).
export const LCP_TABLE_THRESHOLD = 8;
export const LCP_TABLE_PREVIEW_ROWS = 5;

// Local to this file - the return type of `tablePlacement`, not part of the module's public API.
type TablePlacement = "inline" | "lcp";

/** Where a table of `rows` renders: inline in the thread, or as a preview that opens the LCP. */
export function tablePlacement(rows: readonly unknown[]): TablePlacement {
  return rows.length > LCP_TABLE_THRESHOLD ? "lcp" : "inline";
}
