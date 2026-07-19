import { z } from "zod";

// The `data-insight` part: the single payload the agent streams (writer), the web renders
// (renderer), and the store persists (AC-13 resume source). One part type with two kinds - a chart
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

const MetaSchema = z.object({
  sql: z.string(), // the exact executed ClickHouse SQL - Show query reveals this verbatim
  sampleN: z.number(),
  updatedAt: z.string(), // data freshness (max ingested_at), CH text form
});
export type InsightMeta = z.infer<typeof MetaSchema>;

const ChartInsightSchema = z.object({
  id: z.string(),
  kind: z.literal("chart"),
  chartType: ChartTypeSchema,
  verdict: z.string(),
  series: z.array(DataPointSchema),
  followups: z.array(z.string()),
  meta: MetaSchema,
});
export type ChartInsight = z.infer<typeof ChartInsightSchema>;

const TableInsightSchema = z.object({
  id: z.string(),
  kind: z.literal("table"),
  verdict: z.string(),
  rows: z.array(DataPointSchema),
  followups: z.array(z.string()),
  meta: MetaSchema,
});
export type TableInsight = z.infer<typeof TableInsightSchema>;

export const DataInsightSchema = z.discriminatedUnion("kind", [
  ChartInsightSchema,
  TableInsightSchema,
]);
export type DataInsight = z.infer<typeof DataInsightSchema>;
