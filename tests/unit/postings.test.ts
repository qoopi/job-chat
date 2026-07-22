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

  it("coerces a missing employment_type/experience_level to an empty string (CH columns are non-nullable)", () => {
    const row = mapPostingToRow(
      { ...base, employmentType: null, experienceLevel: null },
      ingestedAt,
    );
    expect(row.employment_type).toBe("");
    expect(row.experience_level).toBe("");
  });
});
