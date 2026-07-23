import { z } from "zod";

// jobs-api item boundary (searchnapply GET /api/jobs/postings); Zod strips the fields the table doesn't need.
export const SalarySchema = z.object({
  normalizedMin: z.number().nullish(),
  normalizedMax: z.number().nullish(),
  currency: z.string().nullish(),
});

export const LocationSchema = z.object({
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  // The deployed jobs API returns null (and undocumented kinds) on real rows; mapPostingToRow degrades those to onsite.
  kind: z.number().nullish(),
});

export const PostingSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  company: z.string(),
  source: z.string(),
  employmentType: z.string().nullish(),
  experienceLevel: z.string().nullish(),
  salary: SalarySchema.nullish(),
  locations: z.array(LocationSchema).default([]),
  // Require an explicit UTC (`Z`)/offset: a timezone-less string is read as LOCAL by new Date() and shifts;
  // reject it at the boundary (offsets normalize to UTC).
  publishedAt: z.string().datetime({ offset: true }),
  // The apply/careers-site link the jobs-api attaches per item. Validated (reject junk that would render a
  // dead link) and capped; nullish so an item that omits it still ingests.
  externalApplyUrl: z.string().url().max(2048).nullish(),
});

export type Posting = z.infer<typeof PostingSchema>;

export type LocationKind = "onsite" | "remote" | "hybrid";

/** searchnapply classifies each location with an integer `kind`: 0->onsite, 1->remote, 2->hybrid. Unknown
 *  kinds fall back to onsite (the dominant category) so one odd row never fails a batch. */
export function locationKindLabel(kind: number): LocationKind {
  if (kind === 1) return "remote";
  if (kind === 2) return "hybrid";
  return "onsite";
}

// A postings-table row; DateTimes are pre-formatted to ClickHouse text form (UTC) so JSONEachRow needs no settings.
export interface PostingRow {
  source: string;
  external_id: string;
  title: string;
  company: string;
  city: string | null;
  region: string | null;
  country: string | null;
  location_kind: LocationKind;
  employment_type: string;
  experience_level: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  published_at: string;
  // The apply link-out; empty string when the item carried none (the CH column is non-nullable, DEFAULT '').
  apply_url: string;
  ingested_at: string;
}

/** Format a date to ClickHouse DateTime text form (UTC, "YYYY-MM-DD HH:MM:SS"). One home for the row
 *  timestamps and the delisting-delete predicate. */
export function toChDateTime(input: string | Date): string {
  return new Date(input).toISOString().slice(0, 19).replace("T", " ");
}

export function mapPostingToRow(posting: Posting, ingestedAt: Date): PostingRow {
  // Single location columns: keep the first, drop the rest.
  const loc = posting.locations[0];
  const salary = posting.salary;
  return {
    source: posting.source,
    external_id: String(posting.id),
    title: posting.title,
    company: posting.company,
    city: loc?.city ?? null,
    region: loc?.region ?? null,
    country: loc?.country ?? null,
    location_kind: locationKindLabel(loc?.kind ?? 0),
    employment_type: posting.employmentType ?? "",
    experience_level: posting.experienceLevel ?? "",
    salary_min: salary?.normalizedMin ?? null,
    salary_max: salary?.normalizedMax ?? null,
    salary_currency: salary?.currency ?? null,
    published_at: toChDateTime(posting.publishedAt),
    apply_url: posting.externalApplyUrl ?? "",
    ingested_at: toChDateTime(ingestedAt),
  };
}
