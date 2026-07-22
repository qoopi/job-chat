import { z } from "zod";

// The structured job-seeker profile: the ONE home for the shape the extraction task produces (from a
// resume + GitHub signals), Postgres persists (the `profiles.profile` jsonb), and the surfaces render
// (the profile card, the LCP expanded view). Postgres-only by rule - AC-13: this shape and its fields
// NEVER enter the ClickHouse path (selection sends derived filter VALUES, never the profile itself).
//
// Plain `z.object` (strips unknown keys on parse) rather than `.strict()`: the model fills this schema
// via generateObject, and stripping an extra key it invents is more robust than rejecting the whole
// object. Nullable-not-optional for the scalar unknowns (seniority/remotePref/salaryMin/yearsExp) so
// every field is always PRESENT in the JSON - the renderer reads a stable shape, `null` = "unknown".

/** Seniority band, or `null` when the sources do not pin one. */
export const SENIORITY_LEVELS = ["junior", "mid", "senior", "lead"] as const;

/** A single skill with its provenance: claimed on the resume, proven on GitHub, or both (the card
 *  renders github-proven with an accent + check, resume-claimed as a neutral outline pill). */
const SkillSchema = z.object({
  name: z.string(),
  source: z.enum(["resume", "github", "both"]),
});
export type Skill = z.infer<typeof SkillSchema>;

/** One resume experience entry (rendered in the LCP expanded view only, max 3 bullets visible per role;
 *  `years` is free text - "2021-2024", "3 years" - because resumes phrase it inconsistently). */
const ExperienceSchema = z.object({
  title: z.string(),
  company: z.string(),
  years: z.string(),
  bullets: z.array(z.string()),
});
export type Experience = z.infer<typeof ExperienceSchema>;

export const ProfileSchema = z.object({
  titles: z.array(z.string()),
  seniority: z.enum(SENIORITY_LEVELS).nullable(),
  skills: z.array(SkillSchema),
  locations: z.array(z.string()),
  remotePref: z.boolean().nullable(),
  salaryMin: z.number().nullable(),
  yearsExp: z.number().nullable(),
  domains: z.array(z.string()),
  ossHighlights: z.array(z.string()),
  experience: z.array(ExperienceSchema),
});
export type Profile = z.infer<typeof ProfileSchema>;
