import { z } from "zod";
import { ProfileSchema, type Profile } from "./profile";

export const CHART_TYPES = ["trend", "bars", "histogram", "donut"] as const;
export const ChartTypeSchema = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartTypeSchema>;

const DataPointSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type DataPoint = z.infer<typeof DataPointSchema>;

/** The label column = first NON-NUMERIC column (detected by "not a number", so a null/empty first label
 *  still resolves). One home so the model view and the chart/table reading never disagree. */
export function labelKeyOf(rows: DataPoint[]): string {
  const first = rows[0] ?? {};
  const key = Object.keys(first).find((k) => typeof first[k] !== "number");
  return key ?? Object.keys(first)[0] ?? "label";
}

const MetaSchema = z
  .object({
    sql: z.string(), // exact executed ClickHouse SQL (Show query reveals it)
    sampleN: z.number(),
    updatedAt: z.string(), // data freshness (max ingested_at), CH text form
    // Present only on a current-state read (open-set predicate); absent = full history. Never default-inject.
    openSet: z.boolean().optional(),
    // The currency a salary aggregate was filtered to; OPTIONAL (salary only), never injected.
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

export type ErrorKind = "system" | "unanswerable";

/** Guard refusal reasons; the reason name is the UI contract, the cap VALUE differs by kind. */
export type GuardRefusal = "guest_cap" | "daily_budget";

export type RefusalReason = GuardRefusal | "too_long";

// Each part rides the SDK's `data-<kind>` wire prefix: convertToModelMessages requires a known or
// `data-`/`tool-`-prefixed part type, or the SDK throws on every turn.

/** A scored posting row (postings card). `null` city/salary means "not listed". */
export const ScoredPostingRowSchema = z
  .object({
    title: z.string(),
    company: z.string(),
    city: z.string().nullable(),
    remote: z.boolean(),
    salaryMin: z.number().nullable(),
    salaryMax: z.number().nullable(),
    experience: z.string(),
    publishedAt: z.string(),
    score: z.number(),
  })
  .strict();
export type ScoredPostingRow = z.infer<typeof ScoredPostingRowSchema>;

/** Profile card payload. Appended out-of-band (not a turn) - INVISIBLE to the turn machinery. */
export type ProfileCardPart = { kind: "profile-card"; profile: Profile };
export type PostingsPart = { kind: "postings"; rows: ScoredPostingRow[]; total: number };
export type AuthInvitePart = { kind: "auth-invite" };
export type ProfileInvitePart = { kind: "profile-invite" };

export const ProfileCardSchema = z
  .object({ kind: z.literal("profile-card"), profile: ProfileSchema })
  .strict();

export const PostingsSchema = z
  .object({ kind: z.literal("postings"), rows: z.array(ScoredPostingRowSchema), total: z.number() })
  .strict();

export const AuthInviteSchema = z.object({ kind: z.literal("auth-invite") }).strict();
export const ProfileInviteSchema = z.object({ kind: z.literal("profile-invite") }).strict();

/** True if a persisted row's payload is a profile card. The turn machinery keys off this: the run gate's
 *  already-answered tail and `deleteTrailingAssistant` both skip profile cards (out-of-band, not a turn). */
export function isProfileCardPayload(parts: unknown): boolean {
  return (
    typeof parts === "object" &&
    parts !== null &&
    !Array.isArray(parts) &&
    (parts as { kind?: unknown }).kind === "profile-card"
  );
}
