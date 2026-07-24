import { z } from "zod";
import { ProfileSchema } from "./profile";

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

/** Error-card kinds; the const array is the one home the persist gate + card classifier derive from, so a
 *  new marker can't be silently dropped by either. */
export const ERROR_KINDS = ["system", "unanswerable"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Guard refusal reasons; the reason name is the UI contract, the cap VALUE differs by kind. */
export const GUARD_REFUSALS = ["guest_cap", "daily_budget"] as const;
export type GuardRefusal = (typeof GUARD_REFUSALS)[number];

export const REFUSAL_REASONS = [...GUARD_REFUSALS, "too_long"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** True if `v` is a known error-card kind marker. */
export function isErrorKind(v: unknown): v is ErrorKind {
  return typeof v === "string" && (ERROR_KINDS as readonly string[]).includes(v);
}

/** True if `v` is a known refusal-reason marker. */
export function isRefusalReason(v: unknown): v is RefusalReason {
  return typeof v === "string" && (REFUSAL_REASONS as readonly string[]).includes(v);
}

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
    // The apply link-out. Optional so a pre-backfill persisted snapshot (no apply_url) still parses and
    // renders unchanged; empty/absent -> plain-text title, present -> a link.
    applyUrl: z.string().max(2048).optional(),
    // The natural key (source, external_id): the ONLY row addition, tiny (not the bloaty description_text) -
    // it lets a title click fetch the on-demand detail. Optional so an older persisted snapshot (no key)
    // still parses; a row lacking it renders a plain, non-clickable title.
    source: z.string().max(128).optional(),
    externalId: z.string().max(256).optional(),
  })
  .strict();
export type ScoredPostingRow = z.infer<typeof ScoredPostingRowSchema>;

/** One posting's full detail, read on demand (getPostingDetail) for the in-app detail view. NOT a wire card
 *  payload - a server action returns it typed, so no Zod round-trip. description_text is already PLAIN TEXT
 *  (htmlToText stripped it at ingest); "" renders a valid empty detail. Raw HTML never reaches here. */
export interface PostingDetail {
  title: string;
  company: string;
  city: string | null;
  region: string | null;
  country: string | null;
  remote: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  department: string;
  descriptionText: string;
  applyUrl: string;
}

/** Profile card payload. Appended out-of-band (not a turn) - INVISIBLE to the turn machinery. */
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
