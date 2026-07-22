import { z } from "zod";

// SECURITY: Postgres-only - the profile shape NEVER enters the ClickHouse path (selection sends filter VALUES only).
// z.object (strips unknown keys) not .strict(): tolerate a model-invented key; scalars nullable so every field is present (null = "unknown").

export const SENIORITY_LEVELS = ["junior", "mid", "senior", "lead"] as const;

const SkillSchema = z.object({
  name: z.string(),
  source: z.enum(["resume", "github", "both"]),
});
export type Skill = z.infer<typeof SkillSchema>;

/** One resume experience entry; `years` is free text ("3 years", "18 months") - resumes phrase it inconsistently. */
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
