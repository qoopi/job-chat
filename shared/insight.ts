import { z } from "zod";

// The `data-insight` part: the single payload the agent streams (writer), the web renders
// (renderer), and the store persists (the resume source). One part type with two kinds - a chart
// (one of four primitives + a series) or a table (rows). Modeled as a discriminated union on `kind`
// so the invalid states (a chart without a chartType, a table with a series) cannot be represented;
// the skeleton state is the ABSENCE of the part, not a variant here.

/** The four chart primitives. The fifth design primitive, the table, is `kind: "table"`. */
export const CHART_TYPES = ["trend", "bars", "histogram", "donut"] as const;
export const ChartTypeSchema = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartTypeSchema>;

// A chart datum or table row: string labels + numeric measures (Recharts-shaped, null-tolerant).
const DataPointSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type DataPoint = z.infer<typeof DataPointSchema>;

/**
 * The label column of a row set: the first NON-NUMERIC column (a measure is always a number), detected
 * by "not a number" rather than "is a string" so a null/empty first label still resolves to its column.
 * Falls back to the first column, then "label". ONE home (principles finding 8) so the model view
 * (trigger/parts.ts) and the chart/table reading (src/lib/insight-format.ts) never disagree on which
 * column is the label - a null-in-row-0 label used to split them ("first string" vs "first non-number").
 */
export function labelKeyOf(rows: DataPoint[]): string {
  const first = rows[0] ?? {};
  const key = Object.keys(first).find((k) => typeof first[k] !== "number");
  return key ?? Object.keys(first)[0] ?? "label";
}

const MetaSchema = z
  .object({
    sql: z.string(), // the exact executed ClickHouse SQL - Show query reveals this verbatim
    sampleN: z.number(),
    updatedAt: z.string(), // data freshness (max ingested_at), CH text form
    // Present (true) only on a current-state read (open-set predicate applied) - the source line then
    // reads "N open postings". OPTIONAL so every persisted payload stays valid under strict;
    // absent = full history. Never default-inject it.
    openSet: z.boolean().optional(),
    // The currency a salary aggregate was filtered to - the source line discloses the
    // base and the money formatter uses it. OPTIONAL (only salary insights carry it); never injected.
    currency: z.string().optional(),
  })
  .strict();
export type InsightMeta = z.infer<typeof MetaSchema>;

const ChartInsightSchema = z
  .object({
    id: z.string(),
    kind: z.literal("chart"),
    chartType: ChartTypeSchema,
    verdict: z.string(),
    series: z.array(DataPointSchema),
    followups: z.array(z.string()),
    meta: MetaSchema,
  })
  .strict();
export type ChartInsight = z.infer<typeof ChartInsightSchema>;

const TableInsightSchema = z
  .object({
    id: z.string(),
    kind: z.literal("table"),
    verdict: z.string(),
    rows: z.array(DataPointSchema),
    followups: z.array(z.string()),
    meta: MetaSchema,
  })
  .strict();
export type TableInsight = z.infer<typeof TableInsightSchema>;

export const DataInsightSchema = z.discriminatedUnion("kind", [
  ChartInsightSchema,
  TableInsightSchema,
]);
export type DataInsight = z.infer<typeof DataInsightSchema>;

// The agent's error / refusal taxonomy - the ONE home for the kinds streamed as `data-error` /
// `data-refusal` parts, persisted as their markers, and rendered by the UI. Defined here (shared) so the
// agent (trigger/parts.ts, trigger/guard.ts) and the web (src/lib/insight-format.ts, src/lib/chat-ui.ts)
// read one definition, with no drifting per-layer copies.

/** A `data-error` card kind: a tool/infra failure (`system`) vs a question the data cannot answer. */
export type ErrorKind = "system" | "unanswerable";

/** The cap/budget guard refusal reasons: the per-user message cap (`guest_cap`, whichever cap applied -
 *  the reason name is the UI contract; the cap VALUE differs by kind) and the global daily-budget kill
 *  switch (`daily_budget`). */
export type GuardRefusal = "guest_cap" | "daily_budget";

/** A `data-refusal` card reason: the cap/budget guard plus the over-length (`too_long`) input backstop
 *  refused at the agent-run ingress before persist/model. The UI renders every one as a polite notice. */
export type RefusalReason = GuardRefusal | "too_long";
