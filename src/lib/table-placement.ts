// Table placement: deterministic + CLIENT-side (the agent never decides), so a resume renders identically; >THRESHOLD rows -> LCP preview, else inline; charts always inline.
export const LCP_TABLE_THRESHOLD = 8;
export const LCP_TABLE_PREVIEW_ROWS = 5;

type TablePlacement = "inline" | "lcp";

export function tablePlacement(rows: readonly unknown[]): TablePlacement {
  return rows.length > LCP_TABLE_THRESHOLD ? "lcp" : "inline";
}
