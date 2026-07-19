import { describe, expect, it } from "vitest";
import {
  errorCopy,
  refusalCopy,
  formatUsd,
  labelKeyOf,
  valueKeyOf,
  valueKeysOf,
  splitFirstNumber,
} from "@/lib/insight-format";

describe("errorCopy (AC-10 distinct copies)", () => {
  it("gives the system-failure copy for a 'system' error", () => {
    expect(errorCopy("system")).toBe("Something went wrong on my side - try again");
  });
  it("gives the unanswerable copy for an 'unanswerable' error", () => {
    expect(errorCopy("unanswerable")).toBe("I could not answer that - try rephrasing");
  });
});

describe("refusalCopy (guest cap / daily budget - polite limit)", () => {
  it("gives a polite limit notice for the guest cap", () => {
    const copy = refusalCopy("guest_cap");
    expect(copy.toLowerCase()).toContain("limit");
    expect(copy).not.toContain("error");
  });
  it("gives a distinct notice for the daily budget", () => {
    expect(refusalCopy("daily_budget")).not.toBe(refusalCopy("guest_cap"));
  });
  it("gives a distinct 'too long' notice for an over-length turn", () => {
    const copy = refusalCopy("too_long");
    expect(copy.toLowerCase()).toContain("too long");
    expect(copy).not.toBe(refusalCopy("guest_cap"));
    expect(copy).not.toBe(refusalCopy("daily_budget"));
  });
});

describe("formatUsd (verdict/axis money - numbers are the heroes)", () => {
  it("renders whole thousands as $Nk", () => {
    expect(formatUsd(182000)).toBe("$182k");
  });
  it("rounds to the nearest thousand", () => {
    expect(formatUsd(181600)).toBe("$182k");
  });
  it("renders sub-thousand values in full", () => {
    expect(formatUsd(750)).toBe("$750");
  });
});

describe("splitFirstNumber (verdict number emphasis - numbers are the heroes)", () => {
  it("splits out the first money token", () => {
    expect(splitFirstNumber("Median salary is $182k - 31% above LA.")).toEqual([
      "Median salary is ",
      "$182k",
      " - 31% above LA.",
    ]);
  });
  it("splits out a leading percent token", () => {
    expect(splitFirstNumber("46% of open roles are remote.")).toEqual([
      "",
      "46%",
      " of open roles are remote.",
    ]);
  });
  it("splits out a grouped-thousands count", () => {
    expect(splitFirstNumber("1,204 new postings this week.")).toEqual([
      "",
      "1,204",
      " new postings this week.",
    ]);
  });
  it("returns null when there is no number", () => {
    expect(splitFirstNumber("A good time to switch, yes.")).toBeNull();
  });
});

describe("series key detection (charts read DataPoint[] by convention)", () => {
  const companies = [
    { company: "Amazon", count: 214 },
    { company: "Databricks", count: 121 },
  ];
  const compare = [
    { city: "San Francisco", median: 182000, n: 412 },
    { city: "Los Angeles", median: 139000, n: 359 },
  ];

  it("labelKeyOf picks the first string-valued column", () => {
    expect(labelKeyOf(companies)).toBe("company");
    expect(labelKeyOf(compare)).toBe("city");
  });

  it("valueKeyOf prefers the primary measure over a secondary count", () => {
    expect(valueKeyOf(companies, "company")).toBe("count");
    // median is the headline measure for a salary compare; n is the sample size
    expect(valueKeyOf(compare, "city")).toBe("median");
  });

  it("valueKeysOf returns every numeric measure column (grouped-bars support)", () => {
    expect(valueKeysOf(compare, "city")).toEqual(["median", "n"]);
    expect(valueKeysOf(companies, "company")).toEqual(["count"]);
  });
});
