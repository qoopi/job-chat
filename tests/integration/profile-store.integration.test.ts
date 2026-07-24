import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import { runProfileExtraction } from "../../trigger/profile-extraction";
import type { Profile } from "@shared/profile";

// Integration: the profiles store methods against real managed Postgres. Skipped when DATABASE_URL is
// absent (CI without secrets). Proves the two-phase write (action stores inputs -> task writes the
// extracted profile), the delete, and the re-save-preserves-previous contract.
const hasCreds = Boolean(process.env.DATABASE_URL);

const extracted: Profile = {
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [{ name: "Go", source: "both" }],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 90000,
  yearsExp: 8,
  domains: ["fintech"],
  ossHighlights: ["maintainer of an OSS CLI"],
  experience: [{ title: "Senior Backend Engineer", company: "Acme", years: "2021-2024", bullets: ["Cut p99 40%"] }],
  canonicalRoles: [],
};

describe.skipIf(!hasCreds)("profiles store against real Postgres", () => {
  let sql: Sql;
  let store: Store;
  const userId = `test-guest-${crypto.randomUUID()}`;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    store = createStore(sql);
    await store.getOrCreateUser(userId);
  });

  afterAll(async () => {
    await sql`DELETE FROM profiles WHERE user_id = ${userId}`;
    await sql`DELETE FROM users WHERE user_id = ${userId}`;
    await sql.end();
  });

  // AC-3: a save persists raw inputs + (after the task) the structured profile on the account row.
  it("Should_PersistProfile_When_ResumeSaved: two-phase write persists inputs then the extracted profile (AC-3)", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    // Phase 1 - the save action stores raw inputs; profile/extracted_at are still pending.
    await store.saveProfileInputs({
      userId,
      rawResumeText: "Senior backend engineer, 8 years.",
      resumePdf: pdf,
      githubUsername: "octocat",
    });
    const pending = await store.getProfile(userId);
    expect(pending).not.toBeNull();
    expect(pending!.raw_resume_text).toBe("Senior backend engineer, 8 years.");
    expect(pending!.github_username).toBe("octocat");
    expect(Uint8Array.from(pending!.resume_pdf!)).toEqual(pdf); // the transient bytes are staged
    expect(pending!.profile).toBeNull(); // extraction pending
    expect(pending!.extracted_at).toBeNull();

    // Phase 2 - the extraction task writes the structured profile + stamps time, and reports it updated a
    // row. The transient PDF is NOT nulled here - it survives until the card append succeeds (S1).
    const updated = await store.saveExtractedProfile(userId, extracted);
    expect(updated).toBe(true); // the row existed
    const done = await store.getProfile(userId);
    expect(done!.profile).toEqual(extracted); // structured profile persisted verbatim
    expect(done!.extracted_at).toBeInstanceOf(Date); // the DONE marker the poll waits on
    expect(Uint8Array.from(done!.resume_pdf!)).toEqual(pdf); // PDF still staged (cleared only after the card)
    expect(done!.raw_resume_text).toBe("Senior backend engineer, 8 years."); // raw input preserved

    // Phase 3 - the terminal transient-PII clear runs after the card append succeeds.
    await store.clearResumePdf(userId);
    expect((await store.getProfile(userId))!.resume_pdf).toBeNull(); // transient PII consumed
  });

  // A re-save (the Update flow) must not destroy the working profile: saveProfileInputs replaces the
  // inputs but leaves the prior extracted profile in place until the task overwrites it.
  it("saveProfileInputs re-save keeps the previous extracted profile untouched until re-extraction", async () => {
    // Start from an already-extracted profile (from the prior test's userId is dirty; use a fresh one).
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    await store.saveProfileInputs({ userId: u, rawResumeText: "v1", resumePdf: null, githubUsername: null });
    await store.saveExtractedProfile(u, extracted);

    // Re-save with new inputs (github removed): the old profile + extracted_at survive.
    await store.saveProfileInputs({ userId: u, rawResumeText: "v2", resumePdf: null, githubUsername: null });
    const row = await store.getProfile(u);
    expect(row!.raw_resume_text).toBe("v2"); // inputs replaced
    expect(row!.profile).toEqual(extracted); // previous profile untouched (no data loss on re-save)
    expect(row!.extracted_at).toBeInstanceOf(Date);

    await sql`DELETE FROM profiles WHERE user_id = ${u}`;
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  // The stated reason for the saveProfileInputs/saveExtractedProfile split (Deviation 3): a FAILED
  // re-extraction must never destroy the prior working profile. runProfileExtraction never calls
  // saveExtractedProfile when the model generation throws (extractProfileFields re-throws a transport
  // error immediately - S2), so the whole task run rejects - proved here end-to-end against real Postgres,
  // not just at the store layer: seed an already-extracted profile, re-save new inputs, then run the REAL
  // pipeline function with a `generate` that rejects with a transport error.
  it("a failed re-extraction (model transport error) preserves the prior extracted profile untouched", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    await store.saveProfileInputs({ userId: u, rawResumeText: "v1", resumePdf: null, githubUsername: null });
    await store.saveExtractedProfile(u, extracted);
    const before = await store.getProfile(u);

    // A re-save (new inputs) queues a re-extraction; that re-extraction then fails entirely.
    await store.saveProfileInputs({ userId: u, rawResumeText: "v2 (re-extraction pending)", resumePdf: null, githubUsername: null });
    const failingGenerate = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const cardSpy = vi.spyOn(store, "appendProfileCard");
    await expect(
      runProfileExtraction(
        {
          store,
          fetchGithub: async () => {
            throw new Error("no github in this fixture");
          },
          generate: failingGenerate,
          githubToken: undefined,
        },
        { userId: u, conversationId: crypto.randomUUID() },
      ),
    ).rejects.toThrow("model unavailable");
    expect(failingGenerate).toHaveBeenCalledTimes(1); // a transport error is NOT retried inline - it propagates (S2)

    const after = await store.getProfile(u);
    expect(after!.profile).toEqual(before!.profile); // the WORKING profile survives the failed re-extraction
    expect(after!.profile).toEqual(extracted);
    expect(after!.extracted_at).toEqual(before!.extracted_at); // extracted_at is NOT re-stamped
    expect(after!.raw_resume_text).toBe("v2 (re-extraction pending)"); // the new inputs are staged for a retry
    expect(cardSpy).not.toHaveBeenCalled(); // no card append either - saveExtractedProfile was never reached
    cardSpy.mockRestore();

    await sql`DELETE FROM profiles WHERE user_id = ${u}`;
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  // Must-fix: on a PERMANENT extraction failure (no profile ever produced), markExtractionFailed clears
  // the transient PDF (never long-term PII) AND stamps the terminal marker the poll surfaces.
  it("markExtractionFailed clears the transient PDF and stamps the failure marker (must-fix)", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await store.saveProfileInputs({ userId: u, rawResumeText: null, resumePdf: pdf, githubUsername: null });
    expect((await store.getProfile(u))!.extraction_failed).toBe(false); // fresh save: pending, not failed

    await store.markExtractionFailed(u);
    const failed = await store.getProfile(u);
    expect(failed!.resume_pdf).toBeNull(); // transient PII cleared even though extraction never completed
    expect(failed!.extraction_failed).toBe(true); // the terminal marker the saving panel reads
    expect(failed!.extracted_at).toBeNull(); // still no profile - genuinely failed

    // A re-save queues a fresh attempt and clears the stale failure marker.
    await store.saveProfileInputs({ userId: u, rawResumeText: "retry", resumePdf: null, githubUsername: null });
    expect((await store.getProfile(u))!.extraction_failed).toBe(false);

    await sql`DELETE FROM profiles WHERE user_id = ${u}`;
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  // Must-fix guard: if a profile WAS produced, markExtractionFailed still clears the PDF but does NOT
  // mismark the row as failed (extraction_failed = extracted_at IS NULL).
  it("markExtractionFailed does not mark failed when a profile was already extracted", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    await store.saveProfileInputs({ userId: u, rawResumeText: "r", resumePdf: new Uint8Array([1]), githubUsername: null });
    await store.saveExtractedProfile(u, extracted);
    await store.markExtractionFailed(u);
    const row = await store.getProfile(u);
    expect(row!.resume_pdf).toBeNull(); // PDF still cleared
    expect(row!.extraction_failed).toBe(false); // a real profile exists - not mismarked as failed
    expect(row!.profile).toEqual(extracted);
    await sql`DELETE FROM profiles WHERE user_id = ${u}`;
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  // S3: saveExtractedProfile reports whether it matched a row, so the caller can skip an orphan card.
  it("saveExtractedProfile returns false when the profile row is gone (deleted mid-extraction, S3)", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u); // user exists, but NO profiles row
    expect(await store.saveExtractedProfile(u, extracted)).toBe(false); // matched zero rows
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  // AC-10: deleting a profile removes raw inputs + structured profile; a subsequent read is null (the
  // no-profile / AC-2 invite path). Idempotent.
  it("Should_DeleteProfileAndReinvite_When_ProfileDeleted: delete removes the row; getProfile is null; idempotent (AC-10)", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    await store.saveProfileInputs({ userId: u, rawResumeText: "delete me", resumePdf: null, githubUsername: "x" });
    await store.saveExtractedProfile(u, extracted);
    expect(await store.getProfile(u)).not.toBeNull();

    await store.deleteProfile(u);
    expect(await store.getProfile(u)).toBeNull(); // no profile -> behaves as AC-2 next

    await expect(store.deleteProfile(u)).resolves.toBeUndefined(); // idempotent
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  it("getProfile returns null for a user with no profile row", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    expect(await store.getProfile(u)).toBeNull();
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  // 041: the inline prefs edit patches only salaryMin/locations/remotePref via jsonb merge, leaving every
  // other field (titles, skills, experience, ...) intact, and returns the updated row.
  it("updateProfilePrefs merges the three pref fields and leaves the rest of the profile intact", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    await store.saveProfileInputs({ userId: u, rawResumeText: "r", resumePdf: null, githubUsername: null });
    await store.saveExtractedProfile(u, extracted);

    const updated = await store.updateProfilePrefs(u, { salaryMin: 175000, locations: ["SF", "NYC"], remotePref: false });
    expect(updated).not.toBeNull();
    expect(updated!.salaryMin).toBe(175000);
    expect(updated!.locations).toEqual(["SF", "NYC"]);
    expect(updated!.remotePref).toBe(false);
    // Untouched fields survive the merge verbatim.
    expect(updated!.skills).toEqual(extracted.skills);
    expect(updated!.titles).toEqual(extracted.titles);
    expect(updated!.experience).toEqual(extracted.experience);
    // Persisted (a fresh read matches).
    expect((await store.getProfile(u))!.profile).toEqual(updated);

    // Clearing: nulls + empty locations round-trip through jsonb.
    const cleared = await store.updateProfilePrefs(u, { salaryMin: null, locations: [], remotePref: null });
    expect(cleared!.salaryMin).toBeNull();
    expect(cleared!.locations).toEqual([]);
    expect(cleared!.remotePref).toBeNull();

    await sql`DELETE FROM profiles WHERE user_id = ${u}`;
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  it("updateProfilePrefs returns null for a missing or still-pending (not yet extracted) profile row", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    // No profiles row at all.
    expect(await store.updateProfilePrefs(u, { salaryMin: 1, locations: [], remotePref: null })).toBeNull();
    // A pending row (inputs saved, extraction not done -> profile IS NULL): nothing to edit.
    await store.saveProfileInputs({ userId: u, rawResumeText: "r", resumePdf: null, githubUsername: null });
    expect(await store.updateProfilePrefs(u, { salaryMin: 1, locations: [], remotePref: null })).toBeNull();
    await sql`DELETE FROM profiles WHERE user_id = ${u}`;
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  // 041: replacing the skills array (add/remove) leaves the rest intact and returns the updated row.
  it("updateProfileSkills replaces only the skills array and leaves the rest of the profile intact", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    await store.saveProfileInputs({ userId: u, rawResumeText: "r", resumePdf: null, githubUsername: null });
    await store.saveExtractedProfile(u, extracted);

    const nextSkills = [
      { name: "Go", source: "both" as const },
      { name: "TypeScript", source: "resume" as const }, // added
    ];
    const updated = await store.updateProfileSkills(u, nextSkills);
    expect(updated).not.toBeNull();
    expect(updated!.skills).toEqual(nextSkills);
    expect(updated!.salaryMin).toBe(extracted.salaryMin); // untouched
    expect(updated!.locations).toEqual(extracted.locations); // untouched
    expect((await store.getProfile(u))!.profile!.skills).toEqual(nextSkills); // persisted

    // Removing every proven chip is allowed - an empty array persists.
    const emptied = await store.updateProfileSkills(u, []);
    expect(emptied!.skills).toEqual([]);

    await sql`DELETE FROM profiles WHERE user_id = ${u}`;
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });

  it("updateProfileSkills returns null for a missing/pending profile row", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    expect(await store.updateProfileSkills(u, [{ name: "Go", source: "both" }])).toBeNull();
    await sql`DELETE FROM users WHERE user_id = ${u}`;
  });
});
