import { describe, expect, it, vi } from "vitest";
import type { Profile } from "@shared/profile";
import type { MyProfile } from "@/app/actions";
import { pollProfileSave, type PollDeps } from "@/lib/profile-poll";

// The save poll terminates on every path - success, github-skipped, fresh-save failure, the re-save
// edge (a failed re-extraction while a prior profile exists), and the attempt ceiling. Injected deps +
// an instant sleep keep it fast and deterministic.

vi.mock("@/app/actions", () => ({})); // the module is only imported for its MyProfile type

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [{ name: "Go", source: "both" }],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: null,
  yearsExp: 8,
  domains: [],
  ossHighlights: [],
  experience: [],
  canonicalRoles: [],
  ...overrides,
});

const my = (over: Partial<MyProfile> = {}): MyProfile => ({
  profile: profile(),
  githubUsername: "octocat",
  extractedAt: null,
  extractionFailed: false,
  ...over,
});

function deps(seq: (MyProfile | null)[], runStatus: "pending" | "done" | "failed" = "pending"): PollDeps {
  let i = 0;
  return {
    getMyProfile: vi.fn(async () => seq[Math.min(i++, seq.length - 1)]),
    getRunStatus: vi.fn(async () => ({ status: runStatus })),
    sleep: async () => {},
  };
}

const base = { runId: "run_1", priorExtractedAt: null, hadPriorProfile: false, intervalMs: 0, maxAttempts: 5 };

describe("pollProfileSave", () => {
  it("resolves saved when extracted_at advances (proven skills present)", async () => {
    const d = deps([my({ extractedAt: null }), my({ extractedAt: "2026-07-22T10:00:00Z" })]);
    const out = await pollProfileSave(d, base);
    expect(out.outcome).toBe("saved");
    if (out.outcome === "saved") expect(out.profile.titles).toEqual(["Senior Backend Engineer"]);
  });

  it("resolves github-skipped when a username was given but no skill is proven", async () => {
    const skippedProfile = profile({ skills: [{ name: "Python", source: "resume" }] });
    const d = deps([my({ extractedAt: "2026-07-22T10:00:00Z", profile: skippedProfile, githubUsername: "mkovall" })]);
    const out = await pollProfileSave(d, base);
    expect(out.outcome).toBe("github-skipped");
  });

  it("treats a resume-only save (no username, no proven skills) as plain saved", async () => {
    const resumeOnly = profile({ skills: [{ name: "Python", source: "resume" }] });
    const d = deps([my({ extractedAt: "2026-07-22T10:00:00Z", profile: resumeOnly, githubUsername: null })]);
    const out = await pollProfileSave(d, base);
    expect(out.outcome).toBe("saved");
  });

  it("resolves error when the fresh-save failure marker flips", async () => {
    const d = deps([my({ extractedAt: null, extractionFailed: true, profile: null })]);
    const out = await pollProfileSave(d, base);
    expect(out).toEqual({ outcome: "error", hadPriorProfile: false });
  });

  // The re-save edge: a prior profile exists (extractedAt = T0, so the marker can NEVER flip), the
  // re-extraction fails and never advances extractedAt. Only the terminal run status ends the poll.
  it("resolves error via the run status when a re-save fails with a prior profile (marker can't flip)", async () => {
    const priorAt = "2026-07-22T09:00:00Z";
    const stuck = my({ extractedAt: priorAt, extractionFailed: false }); // never advances, never flips
    const d = deps([stuck, stuck, stuck], "failed");
    const out = await pollProfileSave(d, { ...base, priorExtractedAt: priorAt, hadPriorProfile: true });
    expect(out).toEqual({ outcome: "error", hadPriorProfile: true });
    expect(d.getRunStatus).toHaveBeenCalled();
  });

  it("terminates at the attempt ceiling rather than polling forever", async () => {
    const stuck = my({ extractedAt: "2026-07-22T09:00:00Z" });
    const d = deps([stuck], "pending");
    const out = await pollProfileSave(d, { ...base, priorExtractedAt: "2026-07-22T09:00:00Z", hadPriorProfile: true, maxAttempts: 3 });
    expect(out.outcome).toBe("error");
    expect(d.getMyProfile).toHaveBeenCalledTimes(3);
  });

  // Perf (review should-fix): getRunStatus is only load-bearing for the re-save edge (marker can't flip
  // when a profile already exists). A fresh save (no prior profile) relies solely on extractionFailed /
  // the attempt ceiling, so the run-status round trip must be skipped - it would otherwise double the
  // poll's request volume on the common fresh-save path.
  it("skips the run-status round trip on a fresh save (no prior profile)", async () => {
    const stuck = my({ extractedAt: null, extractionFailed: false }); // never advances, never flips
    const d = deps([stuck, stuck, stuck], "pending");
    const out = await pollProfileSave(d, { ...base, hadPriorProfile: false, maxAttempts: 3 });
    expect(out).toEqual({ outcome: "error", hadPriorProfile: false }); // ceiling reached
    expect(d.getRunStatus).not.toHaveBeenCalled();
  });
});
