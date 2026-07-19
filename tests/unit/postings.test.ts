import { describe, expect, it } from "vitest";
import {
  locationKindLabel,
  mapPostingToRow,
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
