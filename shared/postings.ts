import { z } from "zod";

// The jobs-api item boundary (searchnapply GET /api/jobs/postings). Only the fields
// the postings table needs are declared; Zod strips the rest (descriptionHtml, urls, ...).
export const SalarySchema = z.object({
  normalizedMin: z.number().nullish(),
  normalizedMax: z.number().nullish(),
  currency: z.string().nullish(),
});

export const LocationSchema = z.object({
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  kind: z.number(),
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
  publishedAt: z.string(),
});

export type Posting = z.infer<typeof PostingSchema>;

export type LocationKind = "onsite" | "remote" | "hybrid";

/**
 * searchnapply's enricher classifies every location with an integer `kind`.
 * Full-corpus probe (3483 postings, 2026-07-18): kind in {0: 5441, 1: 134, 2: 48}.
 * Pinned mapping 0->onsite, 1->remote, 2->hybrid; unknown kinds fall back to onsite
 * (the dominant category) so one odd row never fails a batch.
 */
export function locationKindLabel(kind: number): LocationKind {
  if (kind === 1) return "remote";
  if (kind === 2) return "hybrid";
  return "onsite";
}

// A postings-table row. DateTimes are pre-formatted to ClickHouse's text form
// ('YYYY-MM-DD HH:MM:SS', UTC) so JSONEachRow inserts need no special settings.
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
  ingested_at: string;
}

function toChDateTime(input: string | Date): string {
  return new Date(input).toISOString().slice(0, 19).replace("T", " ");
}

export function mapPostingToRow(posting: Posting, ingestedAt: Date): PostingRow {
  // Single location columns per the epic schema: keep the first, drop the rest.
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
    ingested_at: toChDateTime(ingestedAt),
  };
}
