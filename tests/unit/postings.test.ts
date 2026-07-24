import { describe, expect, it } from "vitest";
import {
  locationKindLabel,
  mapPostingToRow,
  PostingSchema,
  type Posting,
} from "@shared/postings";

const base: Posting = {
  id: 320973146,
  title: "Pursuit Lead, Google Cloud Consulting",
  company: "Google",
  source: "GoogleCareers",
  employmentType: "full-time",
  experienceLevel: "Staff",
  salary: null,
  locations: [
    { city: "Tokyo", region: "Tokyo", country: "Japan", kind: 0 },
  ],
  publishedAt: "2026-07-17T23:38:42Z",
  roles: [],
};

const ingestedAt = new Date("2026-07-18T06:00:00Z");

describe("locationKindLabel", () => {
  it("maps the observed searchnapply kinds to onsite/remote/hybrid", () => {
    expect(locationKindLabel(0)).toBe("onsite");
    expect(locationKindLabel(1)).toBe("remote");
    expect(locationKindLabel(2)).toBe("hybrid");
  });

  it("defaults an unknown kind to onsite (the dominant category)", () => {
    expect(locationKindLabel(9)).toBe("onsite");
  });
});

describe("PostingSchema publishedAt boundary", () => {
  it("rejects a timezone-less timestamp (would silently shift when parsed as local time)", () => {
    // Regression: z.string() accepted this and new Date() read it as LOCAL time,
    // so a zoneless 23:38:42 gets stored as 03:38:42 in a UTC+4 runner. Must fail fast.
    const result = PostingSchema.safeParse({ ...base, publishedAt: "2026-07-17T23:38:42" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed publishedAt at the boundary (previously threw mid-batch)", () => {
    // Regression: a non-date string parsed fine, then toChDateTime threw RangeError
    // partway through a batch. The invalid state is now defined away at the boundary.
    const result = PostingSchema.safeParse({ ...base, publishedAt: "not-a-timestamp" });
    expect(result.success).toBe(false);
  });

  it("accepts a Z-suffixed UTC timestamp (the jobs-api contract / fixtures)", () => {
    const result = PostingSchema.safeParse({ ...base, publishedAt: "2026-07-17T23:38:42Z" });
    expect(result.success).toBe(true);
  });

  it("accepts an offset timestamp and converts it to UTC for ClickHouse", () => {
    const result = PostingSchema.safeParse({ ...base, publishedAt: "2026-07-17T23:38:42+02:00" });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.published_at).toBe("2026-07-17 21:38:42"); // +02:00 normalized to UTC
  });
});

describe("mapPostingToRow", () => {
  it("projects the jobs-api item onto the postings row shape", () => {
    const row = mapPostingToRow(base, ingestedAt);
    expect(row.source).toBe("GoogleCareers");
    expect(row.external_id).toBe("320973146"); // numeric id stored as string key
    expect(row.title).toBe("Pursuit Lead, Google Cloud Consulting");
    expect(row.company).toBe("Google");
    expect(row.city).toBe("Tokyo");
    expect(row.region).toBe("Tokyo");
    expect(row.country).toBe("Japan");
    expect(row.location_kind).toBe("onsite");
    expect(row.employment_type).toBe("full-time");
    expect(row.experience_level).toBe("Staff");
    expect(row.published_at).toBe("2026-07-17 23:38:42");
    expect(row.ingested_at).toBe("2026-07-18 06:00:00");
  });

  it("leaves salary columns null when the posting has no salary", () => {
    const row = mapPostingToRow(base, ingestedAt);
    expect(row.salary_min).toBeNull();
    expect(row.salary_max).toBeNull();
    expect(row.salary_currency).toBeNull();
  });

  it("copies normalized salary + currency when salary is present", () => {
    const row = mapPostingToRow(
      {
        ...base,
        salary: { normalizedMin: 96000, normalizedMax: 138000, currency: "USD" },
      },
      ingestedAt,
    );
    expect(row.salary_min).toBe(96000);
    expect(row.salary_max).toBe(138000);
    expect(row.salary_currency).toBe("USD");
  });

  it("takes the first location and tolerates postings with none", () => {
    const row = mapPostingToRow({ ...base, locations: [] }, ingestedAt);
    expect(row.city).toBeNull();
    expect(row.region).toBeNull();
    expect(row.country).toBeNull();
    expect(row.location_kind).toBe("onsite");
  });

  it("maps a remote first-location kind", () => {
    const row = mapPostingToRow(
      {
        ...base,
        locations: [{ city: null, region: "Massachusetts", country: "United States", kind: 1 }],
      },
      ingestedAt,
    );
    expect(row.location_kind).toBe("remote");
    expect(row.city).toBeNull();
  });

  // F6: the DEPLOYED searchnapply API returns location.kind = null on real rows (probed live), and a kind 3
  // it never documented. The strict boundary rejected the nulls and failed the whole page. Relax `kind` to
  // nullish; mapPostingToRow already degrades null/undefined/unknown to onsite (the `?? 0` + unknown fallback).
  it("validates a location with kind null and maps it to onsite (deployed-API reality)", () => {
    const result = PostingSchema.safeParse({
      ...base,
      locations: [{ city: "Austin", region: "Texas", country: "United States", kind: null }],
    });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.location_kind).toBe("onsite");
    expect(row.city).toBe("Austin");
  });

  it("validates an undocumented kind 3 and degrades it to onsite (never fails a batch)", () => {
    const result = PostingSchema.safeParse({
      ...base,
      locations: [{ city: "Austin", region: "Texas", country: "United States", kind: 3 }],
    });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.location_kind).toBe("onsite");
  });

  it("coerces a missing employment_type/experience_level to an empty string (CH columns are non-nullable)", () => {
    const row = mapPostingToRow(
      { ...base, employmentType: null, experienceLevel: null },
      ingestedAt,
    );
    expect(row.employment_type).toBe("");
    expect(row.experience_level).toBe("");
  });

  it("projects a present externalApplyUrl onto apply_url (the link-out source)", () => {
    const url = "https://www.google.com/about/careers/applications/jobs/results/1";
    const row = mapPostingToRow({ ...base, externalApplyUrl: url }, ingestedAt);
    expect(row.apply_url).toBe(url);
  });

  it("defaults apply_url to an empty string when the item carries no externalApplyUrl (CH column is non-nullable)", () => {
    const row = mapPostingToRow(base, ingestedAt);
    expect(row.apply_url).toBe("");
  });
});

describe("PostingSchema externalApplyUrl boundary", () => {
  it("accepts a valid https apply url", () => {
    const result = PostingSchema.safeParse({
      ...base,
      externalApplyUrl: "https://careers.example.com/jobs/42",
    });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.apply_url).toBe("https://careers.example.com/jobs/42");
  });

  it("tolerates an absent externalApplyUrl (nullish - the field is optional on the wire)", () => {
    expect(PostingSchema.safeParse(base).success).toBe(true);
    expect(PostingSchema.safeParse({ ...base, externalApplyUrl: null }).success).toBe(true);
  });

  it("rejects a junk (non-URL) externalApplyUrl at the boundary (never store a dead link)", () => {
    const result = PostingSchema.safeParse({ ...base, externalApplyUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects an over-long url past the 2048 cap (bounded-string discipline)", () => {
    const tooLong = `https://example.com/${"a".repeat(2100)}`;
    const result = PostingSchema.safeParse({ ...base, externalApplyUrl: tooLong });
    expect(result.success).toBe(false);
  });
});

describe("PostingSchema roles boundary (forward-compatible default, name-keyed)", () => {
  it("defaults an ABSENT roles field to [] (the pre-ship payload) and projects an empty name array", () => {
    // base carries no roles field at all - the pre-ship reality. It must parse and project to an empty
    // array so matching falls to the title-term path (unchanged behavior).
    const result = PostingSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect((result.data as Posting).roles).toEqual([]);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.role_names).toEqual([]);
    expect(row).not.toHaveProperty("role_ids"); // the untrustworthy 64-bit id is never stored
  });

  it("parses an explicit empty roles array (an unclassified item) to an empty name array", () => {
    const result = PostingSchema.safeParse({ ...base, roles: [] });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.role_names).toEqual([]);
  });

  it("projects populated roles to the role NAMES (order preserved), dropping the id", () => {
    const result = PostingSchema.safeParse({
      ...base,
      roles: [
        // A real-shaped 64-bit id JSON.parse would round; we ignore it and key on the name.
        { id: 2223409607917404583, name: "Backend Engineer" },
        { id: 45, name: "Platform Engineer" },
      ],
    });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.role_names).toEqual(["Backend Engineer", "Platform Engineer"]);
    expect(row).not.toHaveProperty("role_ids");
  });

  it("dedupes roles by name (first wins), preserving order", () => {
    const row = mapPostingToRow(
      {
        ...base,
        roles: [
          { id: 12, name: "Backend Engineer" },
          { id: 99, name: "Backend Engineer" },
          { id: 7, name: "Data Scientist" },
        ],
      },
      ingestedAt,
    );
    expect(row.role_names).toEqual(["Backend Engineer", "Data Scientist"]);
  });

  it("strips unknown fields on a role rather than failing the batch (object is not strict)", () => {
    const result = PostingSchema.safeParse({
      ...base,
      roles: [{ id: 12, name: "Backend Engineer", weight: 0.9, extra: "x" }],
    });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.role_names).toEqual(["Backend Engineer"]);
  });

  it("parses a role that OMITS the inert id (nullish) rather than failing the batch", () => {
    // id is tolerated-but-unused; a role arriving without it must still parse and project its name,
    // honoring the never-fail-a-batch intent (the name is the only match key).
    const result = PostingSchema.safeParse({
      ...base,
      roles: [{ name: "Backend Engineer" }],
    });
    expect(result.success).toBe(true);
    const row = mapPostingToRow(result.data as Posting, ingestedAt);
    expect(row.role_names).toEqual(["Backend Engineer"]);
  });
});
