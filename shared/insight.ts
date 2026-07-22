import { z } from "zod";
import { ProfileSchema, type Profile } from "./profile";

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

// The profile + fresh-data part kinds - the ONE home for the four persisted parts this feature adds,
// alongside `data-insight`. Each rides the SDK's `data-<kind>` wire prefix (the convertToModelMessages
// contract: a part type must be a known kind or `data-`/`tool-`-prefixed, or the SDK throws on EVERY
// turn), and each persists as its payload here. Only `profile-card` is wired end-to-end in this slice
// (its persistence acceptance below); the other three are emitted with their tools in a later slice -
// the TYPES live here now so the vocabulary has a single definition.

/** One scored posting row the selection scorer returns and the postings card renders. Defined here (the
 *  part vocabulary) so the `postings` part type is self-contained; the scorer that fills it lands with
 *  `searchPostings`. `null` for city/salary means "not listed" (the card shows a muted note, never blank).
 *  A zod schema (not a bare interface) so a `data-postings` payload is classified/validated on the client
 *  exactly as the profile card is - a shape drift is dropped, never rendered as junk. */
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

/** The profile card payload: the structured profile the extraction task produced, rendered as the
 *  in-chat identity card + the LCP expanded view. Appended out-of-band by the save flow (not a turn),
 *  so it is INVISIBLE to the turn machinery - the run gate and `deleteTrailingAssistant` skip it. */
export type ProfileCardPart = { kind: "profile-card"; profile: Profile };
/** The postings card payload: the scored rows plus the pre-limit total for the "8 of 23" framing. */
export type PostingsPart = { kind: "postings"; rows: ScoredPostingRow[]; total: number };
/** The guest fit-intent invite: the authorize-with-Google card (the server decides guest vs signed-in). */
export type AuthInvitePart = { kind: "auth-invite" };
/** The signed-in-without-profile fit-intent invite: the create-profile card (opens the LCP form). */
export type ProfileInvitePart = { kind: "profile-invite" };

/** The profile-card payload validator - the strict shape that makes a `data-profile-card` part
 *  persistable (the run persistence whitelist checks it; a malformed payload is dropped, never stored). */
export const ProfileCardSchema = z
  .object({ kind: z.literal("profile-card"), profile: ProfileSchema })
  .strict();

/** The postings-card payload validator: the scored rows + the pre-limit total for the "8 of 23" framing.
 *  The client classifier validates a `data-postings` part against this before rendering the card. */
export const PostingsSchema = z
  .object({ kind: z.literal("postings"), rows: z.array(ScoredPostingRowSchema), total: z.number() })
  .strict();

/** The two fit-intent invite payloads carry no fields (the whole payload IS the marker). NOT wired into
 *  the classifier in this slice - `classifyCardData` (chat-ui.ts) still does a bare `data.kind === "..."`
 *  check, so these validate nothing today. Pre-staged strict validators for 030, which wires them into
 *  the classifier symmetrically with the card kinds (real rejection of a widened/malformed shape). */
export const AuthInviteSchema = z.object({ kind: z.literal("auth-invite") }).strict();
export const ProfileInviteSchema = z.object({ kind: z.literal("profile-invite") }).strict();

/** True for a persisted assistant row whose payload is a profile card. The out-of-band append rule
 *  keys off this: the run gate computes its already-answered tail over NON-profile-card rows, and
 *  `deleteTrailingAssistant` never deletes one - so a save landing mid-turn cannot skip a redispatched
 *  turn, and a Retry after a save cannot destroy the card. `parts` is the stored jsonb (opaque here). */
export function isProfileCardPayload(parts: unknown): boolean {
  return (
    typeof parts === "object" &&
    parts !== null &&
    !Array.isArray(parts) &&
    (parts as { kind?: unknown }).kind === "profile-card"
  );
}
