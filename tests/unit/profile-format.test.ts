import { describe, expect, it } from "vitest";
import type { Profile } from "@shared/profile";
import {
  formatLocationPref,
  isGithubSkipped,
  parseLocationPref,
  profileSubline,
  profileSummary,
  profileTitle,
  salaryTarget,
  splitSkills,
} from "@/lib/profile-format";

// The profile presentation contracts - the identity verdict, the skill split, the github-skipped
// signal, and the saved-summary counts - shared by the in-chat card, the detail panel expanded view, and the
// form. Pinned here so the three surfaces never derive them differently.

const full: Profile = {
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [
    { name: "ClickHouse", source: "github" },
    { name: "Go", source: "both" },
    { name: "Python", source: "resume" },
    { name: "Terraform", source: "resume" },
  ],
  locations: ["Berlin", "Munich"],
  remotePref: true,
  salaryMin: 120000,
  yearsExp: 8,
  domains: ["distributed systems", "data tooling"],
  ossHighlights: ["Merged PRs to trigger.dev", "ClickHouse migration CLI", "Kafka connector docs"],
  experience: [],
  canonicalRoles: [],
};

describe("profileTitle", () => {
  it("is the first extracted title", () => {
    expect(profileTitle(full)).toBe("Senior Backend Engineer");
  });
  it("falls back when no title was parsed", () => {
    expect(profileTitle({ ...full, titles: [] })).toBe("Job seeker");
  });
});

describe("profileSubline", () => {
  it("compact: years · first location · open to remote (no salary)", () => {
    expect(profileSubline(full)).toBe("8 years · Berlin · open to remote");
  });
  it("expanded: all locations joined + the target salary", () => {
    expect(profileSubline(full, { expanded: true })).toBe(
      "8 years · Berlin or Munich · open to remote · target $120k+",
    );
  });
  it("drops unknown segments with no dangling separator", () => {
    const sparse: Profile = { ...full, yearsExp: null, remotePref: null, locations: [] };
    expect(profileSubline(sparse)).toBe("");
  });
});

describe("salaryTarget", () => {
  it("formats the minimum as a target, or null when absent", () => {
    expect(salaryTarget(full)).toBe("target $120k+");
    expect(salaryTarget({ ...full, salaryMin: null })).toBeNull();
  });
});

describe("splitSkills", () => {
  it("puts github/both in proven and resume in claimed", () => {
    const { proven, claimed } = splitSkills(full);
    expect(proven.map((s) => s.name)).toEqual(["ClickHouse", "Go"]);
    expect(claimed.map((s) => s.name)).toEqual(["Python", "Terraform"]);
  });
});

describe("isGithubSkipped", () => {
  it("is true only when no skill is proven in code", () => {
    expect(isGithubSkipped(full)).toBe(false);
    expect(isGithubSkipped({ ...full, skills: [{ name: "Python", source: "resume" }] })).toBe(true);
  });
});

// 041: the single free-text "Location" edit field <-> the structured {locations, remotePref} prefs.
describe("formatLocationPref / parseLocationPref (round-trip)", () => {
  it("formats locations joined with 'or', appending 'remote' when remotePref", () => {
    expect(formatLocationPref({ locations: ["SF"], remotePref: true })).toBe("SF or remote");
    expect(formatLocationPref({ locations: ["Berlin", "Munich"], remotePref: false })).toBe("Berlin or Munich");
    expect(formatLocationPref({ locations: [], remotePref: null })).toBe("");
    expect(formatLocationPref({ locations: [], remotePref: true })).toBe("remote");
  });

  it("parses a remote keyword into remotePref and drops it from the locations", () => {
    expect(parseLocationPref("SF or remote")).toEqual({ locations: ["SF"], remotePref: true });
    expect(parseLocationPref("Remote")).toEqual({ locations: [], remotePref: true });
  });

  it("splits on comma / slash / 'or', trims, dedupes case-insensitively; no remote keyword => remotePref false", () => {
    expect(parseLocationPref("Berlin, Munich / London")).toEqual({
      locations: ["Berlin", "Munich", "London"],
      remotePref: false,
    });
    expect(parseLocationPref("SF or sf or  SF ")).toEqual({ locations: ["SF"], remotePref: false });
  });

  it("empty text clears both prefs (locations [], remotePref null)", () => {
    expect(parseLocationPref("")).toEqual({ locations: [], remotePref: null });
    expect(parseLocationPref("   ")).toEqual({ locations: [], remotePref: null });
  });

  it("round-trips a format then parse for a physical + remote profile", () => {
    const text = formatLocationPref({ locations: ["SF"], remotePref: true });
    expect(parseLocationPref(text)).toEqual({ locations: ["SF"], remotePref: true });
  });
});

describe("profileSummary", () => {
  it("counts skills (with proven), domains, and OSS highlights", () => {
    expect(profileSummary(full)).toBe("4 skills (2 proven in code) · 2 domains · 3 OSS highlights");
  });
  it("singularizes a lone item", () => {
    const one: Profile = {
      ...full,
      skills: [{ name: "Go", source: "github" }],
      domains: ["data"],
      ossHighlights: ["one thing"],
    };
    expect(profileSummary(one)).toBe("1 skill (1 proven in code) · 1 domain · 1 OSS highlight");
  });
});
