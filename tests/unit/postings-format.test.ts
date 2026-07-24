import { describe, expect, it } from "vitest";
import type { ScoredPostingRow } from "@shared/insight";
import {
  corpusHonesty,
  hasSalary,
  isSeniorPlus,
  locationLabel,
  openPanelLabel,
  postingsVerdict,
  salaryLabel,
  shownCount,
} from "@/lib/postings-format";

// The postings table-cell + corpus-honesty contracts, pinned so the in-chat card and the detail panel full list
// read the same values. "not listed" for a missing salary (never blank); the honesty share is computed.

function row(over: Partial<ScoredPostingRow> = {}): ScoredPostingRow {
  return {
    title: "Senior Backend Engineer",
    company: "Google",
    city: "Munich",
    remote: false,
    salaryMin: 95000,
    salaryMax: 140000,
    experience: "Senior",
    publishedAt: "2026-07-20",
    score: 0.9,
    ...over,
  };
}

describe("salaryLabel", () => {
  it("formats a range", () => {
    expect(salaryLabel(row())).toBe("$95k–$140k");
  });
  it("reads 'not listed' when neither bound is known (never blank)", () => {
    expect(salaryLabel(row({ salaryMin: null, salaryMax: null }))).toBe("not listed");
  });
  it("formats a single bound", () => {
    expect(salaryLabel(row({ salaryMin: null, salaryMax: 130000 }))).toBe("$130k");
  });
});

describe("locationLabel", () => {
  it("is 'Remote' for a remote role", () => {
    expect(locationLabel(row({ remote: true }))).toBe("Remote");
  });
  it("is the city otherwise", () => {
    expect(locationLabel(row({ remote: false, city: "Zurich" }))).toBe("Zurich");
  });
});

describe("hasSalary / isSeniorPlus", () => {
  it("hasSalary reflects either bound present", () => {
    expect(hasSalary(row())).toBe(true);
    expect(hasSalary(row({ salaryMin: null, salaryMax: null }))).toBe(false);
  });
  it("isSeniorPlus matches senior/staff/lead", () => {
    expect(isSeniorPlus(row({ experience: "Senior" }))).toBe(true);
    expect(isSeniorPlus(row({ experience: "Staff" }))).toBe(true);
    expect(isSeniorPlus(row({ experience: "Mid" }))).toBe(false);
  });
  it("isSeniorPlus counts executive/head (lead band per BAND_KEYWORDS, matching the scorer)", () => {
    expect(isSeniorPlus(row({ experience: "Executive" }))).toBe(true);
    expect(isSeniorPlus(row({ experience: "Head of Engineering" }))).toBe(true);
  });
});

describe("corpusHonesty", () => {
  it("computes the top company's share (not hardcoded)", () => {
    const rows = [
      row({ company: "Google" }),
      row({ company: "Google" }),
      row({ company: "Google" }),
      row({ company: "Datadog" }),
    ];
    expect(corpusHonesty(rows)).toEqual({ company: "Google", share: 75 });
  });
  it("is null on a tie (no single 'most matches')", () => {
    expect(corpusHonesty([row({ company: "A" }), row({ company: "B" })])).toBeNull();
  });
  it("is null for too few rows", () => {
    expect(corpusHonesty([row()])).toBeNull();
  });
});

describe("shownCount / postingsVerdict", () => {
  it("caps the shown count at 8", () => {
    expect(shownCount(Array.from({ length: 23 }, () => row()))).toBe(8);
    expect(shownCount(Array.from({ length: 5 }, () => row()))).toBe(5);
  });
  it("verdict frames total + shown when capped", () => {
    expect(postingsVerdict(23, 8)).toBe("23 postings match your profile — showing the best 8.");
  });
  it("verdict omits the 'showing the best' clause when all are shown", () => {
    expect(postingsVerdict(5, 5)).toBe("5 postings match your profile.");
  });
});

// The honesty contract: the chip claims "all" only when the panel actually holds every row (rowsShown covers
// total); otherwise the panel is truncated and the chip must say "top N of M" instead of overclaiming "all".
// The fit search loads limit=50 so rowsShown == min(50, total) — coverage there is equivalent to total<=50.
describe("openPanelLabel", () => {
  it("is literal 'Open all N' when the panel holds the complete set (rowsShown covers total)", () => {
    expect(openPanelLabel(23, 23)).toBe("Open all 23");
    expect(openPanelLabel(50, 50)).toBe("Open all 50");
  });
  it("adapts to 'Open top N of M' once the panel is truncated (rowsShown < total)", () => {
    expect(openPanelLabel(50, 51)).toBe("Open top 50 of 51");
    expect(openPanelLabel(50, 200)).toBe("Open top 50 of 200");
  });
  // latest_postings loads limit=20, so a company with 21-50 latest postings gives rowsShown=20 < total<=50:
  // within the old cap but NOT complete — the chip must not overclaim "all".
  it("does not overclaim 'all' for a truncated latest-list within the cap", () => {
    expect(openPanelLabel(20, 35)).toBe("Open top 20 of 35");
    expect(openPanelLabel(20, 50)).toBe("Open top 20 of 50");
  });
});
