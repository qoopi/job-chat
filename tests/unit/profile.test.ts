import { describe, expect, it } from "vitest";
import { ProfileSchema, type Profile } from "@shared/profile";

// The ProfileSchema is the extraction task's output contract and the persisted profile shape. It must
// accept a fully-populated profile, keep every field PRESENT (nullable-not-optional for the scalars),
// and strip a stray key the model might invent (plain z.object, not strict) rather than reject the whole.

const full: Profile = {
  titles: ["Senior Backend Engineer", "Platform Engineer"],
  seniority: "senior",
  skills: [
    { name: "Go", source: "both" },
    { name: "PostgreSQL", source: "resume" },
    { name: "Kubernetes", source: "github" },
  ],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 90000,
  yearsExp: 8,
  domains: ["fintech", "developer tools"],
  ossHighlights: ["maintainer of an OSS CLI with 2k stars"],
  experience: [
    {
      title: "Senior Backend Engineer",
      company: "Acme",
      years: "2021-2024",
      bullets: ["Cut p99 latency 40%", "Led the payments rewrite"],
    },
  ],
  canonicalRoles: ["Backend Engineer", "Platform Engineer"],
};

describe("ProfileSchema", () => {
  it("accepts a fully-populated profile and round-trips it", () => {
    const parsed = ProfileSchema.parse(full);
    expect(parsed).toEqual(full);
  });

  it("accepts null for every unknown scalar (seniority/remotePref/salaryMin/yearsExp)", () => {
    const sparse: Profile = {
      titles: [],
      seniority: null,
      skills: [],
      locations: [],
      remotePref: null,
      salaryMin: null,
      yearsExp: null,
      domains: [],
      ossHighlights: [],
      experience: [],
      canonicalRoles: [],
    };
    expect(ProfileSchema.parse(sparse)).toEqual(sparse);
  });

  // Forward-compat: a legacy profile persisted before 056 has no canonicalRoles key; the JSONB read
  // path must degrade it to [] (title-expansion fallback), never reject it.
  it("defaults canonicalRoles to [] when the field is absent (legacy profile)", () => {
    const { canonicalRoles: _omit, ...legacy } = full;
    expect(ProfileSchema.parse(legacy).canonicalRoles).toEqual([]);
  });

  it("preserves canonicalRoles when present (the resolved role labels)", () => {
    const parsed = ProfileSchema.parse({ ...full, canonicalRoles: ["SDET", "Test Engineer"] });
    expect(parsed.canonicalRoles).toEqual(["SDET", "Test Engineer"]);
  });

  it("strips an unknown key the model might invent (not strict)", () => {
    const withExtra = { ...full, hobbies: ["climbing"] };
    const parsed = ProfileSchema.parse(withExtra);
    expect(parsed).not.toHaveProperty("hobbies");
    expect(parsed).toEqual(full);
  });

  it("rejects an out-of-set seniority", () => {
    expect(ProfileSchema.safeParse({ ...full, seniority: "principal" }).success).toBe(false);
  });

  it("rejects an out-of-set skill source", () => {
    const bad = { ...full, skills: [{ name: "Go", source: "linkedin" }] };
    expect(ProfileSchema.safeParse(bad).success).toBe(false);
  });
});
