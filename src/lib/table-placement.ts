// Table placement: deterministic + CLIENT-side (the agent never decides), so a resume renders identically; >THRESHOLD rows -> detail panel preview, else inline; charts always inline.
export const DETAIL_TABLE_THRESHOLD = 8;
export const DETAIL_TABLE_PREVIEW_ROWS = 5;

type TablePlacement = "inline" | "detail";

export function tablePlacement(rows: readonly unknown[]): TablePlacement {
  return rows.length > DETAIL_TABLE_THRESHOLD ? "detail" : "inline";
}
