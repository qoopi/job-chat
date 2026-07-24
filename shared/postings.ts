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

// A canonical role the jobs-api tags a posting with. The id is TOLERATED (nullish) but never used for
// logic: it is a 64-bit integer JSON.parse silently rounds past the JS safe-integer limit, so only the
// name (a canonical unique string) is trustworthy. Unknown fields are stripped (not .strict) and the id
// is optional so an evolving role shape - or a role that omits the id - never fails a batch.
export const RoleSchema = z.object({
  id: z.number().nullish(),
  name: z.string(),
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
  // The canonical roles the item carries: ALWAYS an array, EMPTY when the item is unclassified. The
  // field is ABSENT on the pre-ship payload, so .default([]) makes an absent field AND an empty array
  // both parse to [] - matching then falls to the title-term path (unchanged behavior) until the field
  // ships and a re-ingest populates it.
  roles: z.array(RoleSchema).default([]),
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
  // The canonical role NAMES (deduped, order preserved), empty for an unclassified posting. Names are the
  // matching key: the role id on the wire is a 64-bit integer that JSON.parse silently rounds past the JS
  // safe-integer limit, so it is never trustworthy - the name (a canonical unique string) drives matching.
  role_names: string[];
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
  // Project the canonical role NAMES, deduped (first wins) and order-preserved. The wire id is a 64-bit
  // integer JSON.parse rounds past the JS safe-integer limit, so it is dropped - the name is the key.
  const seenRole = new Set<string>();
  const roleNames: string[] = [];
  for (const role of posting.roles) {
    if (seenRole.has(role.name)) continue;
    seenRole.add(role.name);
    roleNames.push(role.name);
  }
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
    role_names: roleNames,
    ingested_at: toChDateTime(ingestedAt),
  };
}
