import { describe, expect, it, vi } from "vitest";
import {
  buildExtractionPrompt,
  extractProfileFields,
  markProfileExtractionFailed,
  resolveCanonicalRoles,
  runProfileExtraction,
  type ExtractionMessage,
  type GenerateProfile,
} from "../../trigger/profile-extraction";
import { profileCardMessageId } from "../../trigger/profile-card-id";
import type { GithubSignals } from "../../trigger/github-profile";
import type { Profile } from "@shared/profile";
import type { ProfileRow, Store } from "@shared/store";

// The extraction pipeline over mocked seams (no Bedrock, no network). Proves the PDF goes to the model
// as a document block (same schema as the paste path), a GitHub failure degrades to a resume-only save,
// github-only extraction works, the deterministic-id card is appended, and one retry recovers a bad gen.

const PROFILE: Profile = {
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [{ name: "Go", source: "both" }],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 90000,
  yearsExp: 8,
  domains: ["fintech"],
  ossHighlights: ["OSS CLI maintainer"],
  experience: [],
  canonicalRoles: [],
};

function signals(): GithubSignals {
  return {
    username: "octocat",
    name: "The Octocat",
    bio: null,
    location: "Berlin",
    publicRepos: 2,
    languages: ["Go"],
    topics: ["fintech"],
    repos: [{ name: "acme", description: "payments CLI", language: "Go", topics: ["fintech"], stars: 2000 }],
    readmes: [{ repo: "acme", excerpt: "A Go CLI" }],
    mergedPrCount: 42,
    recentEventTypes: ["PushEvent"],
    capped: false,
  };
}

/** A fake store: getProfile returns the given row; records saveExtractedProfile / appendProfileCard /
 *  clearResumePdf. `saveUpdatesRow:false` models a row deleted mid-extraction (the UPDATE matches 0 rows). */
function fakeStore(row: ProfileRow | null, opts: { saveUpdatesRow?: boolean } = {}) {
  const saved: Profile[] = [];
  const cards: { conversationId: string; id: string; parts: unknown }[] = [];
  const cleared: string[] = []; // clearResumePdf calls - the terminal transient-PII clear
  const store = {
    getProfile: async () => row,
    saveExtractedProfile: async (_userId: string, profile: Profile) => {
      saved.push(profile);
      return opts.saveUpdatesRow ?? true; // did the UPDATE ... WHERE user_id match a row?
    },
    appendProfileCard: async (conversationId: string, id: string, parts: unknown) => {
      cards.push({ conversationId, id, parts });
    },
    clearResumePdf: async (userId: string) => {
      cleared.push(userId);
    },
  } as unknown as Store;
  return { store, saved, cards, cleared };
}

function row(overrides: Partial<ProfileRow>): ProfileRow {
  return {
    user_id: "u1",
    raw_resume_text: null,
    resume_pdf: null,
    github_username: null,
    profile: null,
    extracted_at: null,
    extraction_failed: false,
    ...overrides,
  };
}

const filePart = (m: ExtractionMessage) => m.content.find((p) => p.type === "file");

describe("buildExtractionPrompt", () => {
  it("attaches a PDF resume as an application/pdf document block (AC-4)", () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { messages } = buildExtractionPrompt({ resumePdf: pdf });
    const file = filePart(messages[0]);
    expect(file).toBeDefined();
    expect(file).toMatchObject({ type: "file", mediaType: "application/pdf" });
    expect((file as { data: Uint8Array }).data).toBe(pdf);
  });

  it("puts a pasted resume inline as text, no document block (same schema target as the PDF path, AC-4)", () => {
    const { messages } = buildExtractionPrompt({ resumeText: "Senior backend engineer" });
    expect(filePart(messages[0])).toBeUndefined();
    expect(messages[0].content.some((p) => p.type === "text" && p.text.includes("Senior backend engineer"))).toBe(true);
  });

  it("includes the GitHub signals block when present", () => {
    const { messages } = buildExtractionPrompt({ resumeText: "x", githubSignals: signals() });
    const text = messages[0].content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    expect(text).toContain("GitHub @octocat");
    expect(text).toContain("Merged public PRs: 42");
  });

  // F5a: the operator's saved profile was built from GitHub ALONE (repos became "jobs", the resume's
  // positions were dropped). The SYSTEM prompt must demand exhaustive resume-only experience, keep repos
  // as ossHighlights (never experience entries), and tag skill sources honestly.
  it("SYSTEM demands exhaustive resume-only experience, repos as ossHighlights, honest source tags (F5a)", () => {
    const { system } = buildExtractionPrompt({ resumeText: "x" });
    expect(system).toMatch(/every position/i); // exhaustive extraction
    expect(system).toMatch(/exhaustively/i);
    expect(system).toMatch(/only from the resume/i); // experience[] from the resume's employment history only
    expect(system).toMatch(/ossHighlights/); // repos live here...
    expect(system).toMatch(/never (an |in )?experience/i); // ...never as experience entries
    expect(system).toMatch(/honest/i); // skill source tags honest
  });
});

describe("extractProfileFields", () => {
  it("retries once on a schema-invalid generation (Zod), then returns the profile", async () => {
    // The model returned an object that fails ProfileSchema (titles must be an array); a single re-ask
    // recovers it - this is the ONLY case the inner retry is for.
    const generate = vi
      .fn<GenerateProfile>()
      .mockResolvedValueOnce({ titles: "not-an-array" } as unknown as Profile)
      .mockResolvedValueOnce(PROFILE);
    const result = await extractProfileFields(generate, { resumeText: "x" });
    expect(result).toEqual(PROFILE);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-schema (transport) error - it propagates to the task's own retry (S2)", async () => {
    // A throttle/transport failure is the schemaTask's retry to own (with backoff), not the inner one:
    // re-throw immediately so the model-call fan-out can never compound to the ~18-call worst case.
    const generate = vi.fn<GenerateProfile>().mockRejectedValue(new Error("throttled: 429"));
    await expect(extractProfileFields(generate, { resumeText: "x" })).rejects.toThrow("throttled");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCanonicalRoles (searchnapply autocomplete at extraction)", () => {
  it("keeps direct-hit labels with jobCount>0, deduped case-insensitively, using the LABEL only", async () => {
    const resolve = vi.fn(async (phrase: string) =>
      phrase === "SDET"
        ? [{ label: "SDET", jobCount: 7, matched: null }, { label: "Test Engineer", jobCount: 13, matched: null }]
        : [{ label: "test engineer", jobCount: 5, matched: null }, { label: "Obscure", jobCount: 0, matched: null }],
    );
    const labels = await resolveCanonicalRoles(resolve, ["SDET", "Test Automation Engineer"]);
    // jobCount 0 dropped ("Obscure"); "test engineer" is a case-insensitive dup of "Test Engineer".
    expect(labels).toEqual(["SDET", "Test Engineer"]);
  });

  it("DIRECT-ONLY: drops fuzzy alias matches (matched is a string), keeps direct hits (matched null/absent)", async () => {
    // The autocomplete for a QA/SDET phrase returns the direct canonical hit PLUS foreign-family aliases
    // (Software Engineering Manager via "Senior Software Engineering Manager", DevOps via an alias). Only
    // the direct hit belongs in "roles that fit you"; the aliases would flood it with unrelated jobs.
    const resolve = vi.fn(async () => [
      { label: "SDET", jobCount: 5, matched: null }, // direct hit -> keep
      { label: "Software Engineering Manager", jobCount: 140, matched: "Senior Software Engineering Manager" }, // alias -> drop
      { label: "DevOps Engineer", jobCount: 10, matched: "DevOps Automation Engineer" }, // alias -> drop
      { label: "Automation Engineer", jobCount: 6 }, // matched absent (== null) -> keep
    ]);
    const labels = await resolveCanonicalRoles(resolve, ["Senior Software Engineer in Test"]);
    expect(labels).toEqual(["SDET", "Automation Engineer"]);
  });

  it("dedupes phrases case-insensitively - one autocomplete call per distinct phrase", async () => {
    const resolve = vi.fn(async () => [{ label: "QA Engineer", jobCount: 14 }]);
    await resolveCanonicalRoles(resolve, ["QA Engineer", "qa engineer", "  QA Engineer  "]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("GRACEFUL: a rejecting resolver yields [] and never throws (the profile still saves)", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("searchnapply 503");
    });
    await expect(resolveCanonicalRoles(resolve, ["SDET"])).resolves.toEqual([]);
  });

  it("caps the stored labels at 10", async () => {
    const resolve = vi.fn(async (phrase: string) => [{ label: `Role ${phrase}`, jobCount: 1 }]);
    const many = Array.from({ length: 20 }, (_, i) => `p${i}`);
    expect((await resolveCanonicalRoles(resolve, many)).length).toBe(10);
  });
});

describe("markProfileExtractionFailed (terminal-failure marker, must-fix)", () => {
  it("clears the transient PDF and stamps the failure marker via the store", async () => {
    // The task's onFailure hook calls this after ALL retries are exhausted (a PERMANENT failure). The
    // store method NULLs resume_pdf (never long-term PII) and stamps the marker getMyProfile surfaces.
    const failed: string[] = [];
    const store = {
      markExtractionFailed: async (u: string) => {
        failed.push(u);
      },
    } as unknown as Store;
    await markProfileExtractionFailed(store, "u1");
    expect(failed).toEqual(["u1"]);
  });
});

describe("runProfileExtraction", () => {
  it("Should_ExtractFromPdfDocument_When_PdfUploaded: PDF -> document block -> saved + card appended (AC-4)", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { store, saved, cards, cleared } = fakeStore(row({ resume_pdf: pdf, github_username: "octocat" }));
    let seen: ExtractionMessage[] = [];
    const generate = vi.fn<GenerateProfile>(async ({ messages }) => {
      seen = messages;
      return PROFILE;
    });
    const fetchGithub = vi.fn(async () => signals());

    const result = await runProfileExtraction({ store, fetchGithub, generate, githubToken: "tok" }, { userId: "u1", conversationId: "c1" });

    expect(result).toEqual(PROFILE);
    expect(filePart(seen[0])).toMatchObject({ mediaType: "application/pdf" }); // the model got the document block
    expect(saved).toEqual([PROFILE]); // structured profile persisted
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(profileCardMessageId("c1")); // deterministic card id
    expect(cards[0].parts).toEqual({ kind: "profile-card", profile: PROFILE });
    expect(cleared).toEqual(["u1"]); // transient PDF cleared AFTER the card append succeeded (S1)
  });

  it("Should_SaveResumeOnly_When_GithubFails: a GitHub failure still saves a resume-derived profile (AC-5)", async () => {
    const { store, saved, cards } = fakeStore(row({ raw_resume_text: "Senior backend engineer", github_username: "octocat" }));
    let seen: ExtractionMessage[] = [];
    const generate = vi.fn<GenerateProfile>(async ({ messages }) => {
      seen = messages;
      return PROFILE;
    });
    const fetchGithub = vi.fn(async () => {
      throw new Error("GitHub 503");
    });

    const result = await runProfileExtraction({ store, fetchGithub, generate, githubToken: "tok" }, { userId: "u1", conversationId: "c1" });

    expect(result).toEqual(PROFILE); // saved despite the GitHub failure
    expect(saved).toEqual([PROFILE]);
    expect(cards).toHaveLength(1);
    // No GitHub block reached the model (resume-only).
    const text = seen[0].content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    expect(text).not.toContain("GitHub @");
    expect(text).toContain("Senior backend engineer");
  });

  it("Should_ExtractFromGithubOnly_When_NoResume: github-only produces and saves a profile", async () => {
    const { store, saved, cards } = fakeStore(row({ github_username: "octocat" })); // no resume text/pdf
    let seen: ExtractionMessage[] = [];
    const generate = vi.fn<GenerateProfile>(async ({ messages }) => {
      seen = messages;
      return PROFILE;
    });
    const fetchGithub = vi.fn(async () => signals());

    const result = await runProfileExtraction({ store, fetchGithub, generate, githubToken: undefined }, { userId: "u1", conversationId: "c1" });

    expect(result).toEqual(PROFILE);
    expect(saved).toEqual([PROFILE]);
    expect(cards).toHaveLength(1);
    expect(fetchGithub).toHaveBeenCalledWith("octocat", undefined); // capped fetch (no token)
    const text = seen[0].content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    expect(text).toContain("no resume yet"); // github-only prompt path
    expect(text).toContain("GitHub @octocat");
  });

  it("resolves + stores canonicalRoles from the profile's title + experience signals (item 3)", async () => {
    const { store, saved, cards } = fakeStore(row({ raw_resume_text: "x" }));
    const extracted: Profile = {
      ...PROFILE,
      titles: ["QA Automation Engineer"],
      experience: [{ title: "SDET", company: "Acme", years: "3y", bullets: [] }],
      canonicalRoles: [], // the model's output; overwritten by autocomplete resolution
    };
    const generate = vi.fn<GenerateProfile>(async () => extracted);
    const resolveRoles = vi.fn(async (phrase: string) =>
      phrase === "QA Automation Engineer"
        ? [{ label: "QA Engineer", jobCount: 14 }]
        : phrase === "SDET"
          ? [{ label: "SDET", jobCount: 7 }]
          : [],
    );

    const result = await runProfileExtraction(
      { store, fetchGithub: vi.fn(), generate, githubToken: undefined, resolveRoles },
      { userId: "u1", conversationId: "c1" },
    );

    expect(result?.canonicalRoles).toEqual(["QA Engineer", "SDET"]);
    expect(saved[0].canonicalRoles).toEqual(["QA Engineer", "SDET"]); // persisted on the profile
    expect(cards[0].parts).toMatchObject({ profile: { canonicalRoles: ["QA Engineer", "SDET"] } });
    // The autocomplete signals are the profile's titles + experience titles.
    expect(resolveRoles.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["QA Automation Engineer", "SDET"]),
    );
  });

  it("GRACEFUL: no resolver (no searchnapply creds) -> canonicalRoles [] and the profile still saves", async () => {
    const { store, saved } = fakeStore(row({ raw_resume_text: "x" }));
    const generate = vi.fn<GenerateProfile>(async () => PROFILE);
    const result = await runProfileExtraction(
      { store, fetchGithub: vi.fn(), generate, githubToken: undefined },
      { userId: "u1", conversationId: "c1" },
    );
    expect(result?.canonicalRoles).toEqual([]);
    expect(saved[0].canonicalRoles).toEqual([]);
  });

  it("GRACEFUL: a failing resolver -> canonicalRoles [] and the profile still saves (never fail the save)", async () => {
    const { store, saved } = fakeStore(row({ raw_resume_text: "x" }));
    const generate = vi.fn<GenerateProfile>(async () => PROFILE);
    const resolveRoles = vi.fn(async () => {
      throw new Error("searchnapply down");
    });
    const result = await runProfileExtraction(
      { store, fetchGithub: vi.fn(), generate, githubToken: undefined, resolveRoles },
      { userId: "u1", conversationId: "c1" },
    );
    expect(result?.canonicalRoles).toEqual([]);
    expect(saved[0].canonicalRoles).toEqual([]);
  });

  it("is a no-op when the profile row was deleted before the task ran", async () => {
    const { store, saved, cards } = fakeStore(null);
    const generate = vi.fn<GenerateProfile>(async () => PROFILE);
    const fetchGithub = vi.fn(async () => signals());
    const result = await runProfileExtraction({ store, fetchGithub, generate, githubToken: "tok" }, { userId: "u1", conversationId: "c1" });
    expect(result).toBeNull();
    expect(saved).toEqual([]);
    expect(cards).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("Should_SkipCard_When_ProfileWriteNoOps: no orphan card / no PDF-clear when the row was deleted mid-extraction (S3)", async () => {
    // The profile was deleted AFTER the task read it: saveExtractedProfile's UPDATE ... WHERE user_id
    // matches zero rows. The pipeline must not append a card for a profile that no longer exists.
    const { store, saved, cards, cleared } = fakeStore(row({ raw_resume_text: "x" }), { saveUpdatesRow: false });
    const generate = vi.fn<GenerateProfile>(async () => PROFILE);
    const fetchGithub = vi.fn(async () => signals());
    const result = await runProfileExtraction({ store, fetchGithub, generate, githubToken: "tok" }, { userId: "u1", conversationId: "c1" });
    expect(result).toBeNull(); // reports "gone"
    expect(saved).toEqual([PROFILE]); // it attempted the write
    expect(cards).toEqual([]); // ... but appended NO card (no orphan)
    expect(cleared).toEqual([]); // ... and cleared nothing
  });

  it("clears the transient PDF only AFTER the card append succeeds, and never if it throws (S1)", async () => {
    const generate = vi.fn<GenerateProfile>(async () => PROFILE);
    // Success: clearResumePdf runs LAST, after saveExtractedProfile + appendProfileCard.
    const order: string[] = [];
    const okStore = {
      getProfile: async () => row({ resume_pdf: new Uint8Array([1]) }),
      saveExtractedProfile: async () => {
        order.push("save");
        return true;
      },
      appendProfileCard: async () => {
        order.push("card");
      },
      clearResumePdf: async () => {
        order.push("clear");
      },
    } as unknown as Store;
    await runProfileExtraction({ store: okStore, fetchGithub: vi.fn(), generate, githubToken: undefined }, { userId: "u1", conversationId: "c1" });
    expect(order).toEqual(["save", "card", "clear"]);

    // Transient blip: the card append throws, so the run rejects (schemaTask retries) and the PDF is
    // NEVER cleared - a re-entry still has the real PDF to re-extract a PDF-only resume (not the degraded
    // no-resume branch).
    const cleared: string[] = [];
    const blipStore = {
      getProfile: async () => row({ resume_pdf: new Uint8Array([1]) }),
      saveExtractedProfile: async () => true,
      appendProfileCard: async () => {
        throw new Error("db blip");
      },
      clearResumePdf: async (u: string) => {
        cleared.push(u);
      },
    } as unknown as Store;
    await expect(
      runProfileExtraction({ store: blipStore, fetchGithub: vi.fn(), generate, githubToken: undefined }, { userId: "u1", conversationId: "c1" }),
    ).rejects.toThrow("db blip");
    expect(cleared).toEqual([]); // PDF preserved for the retry
  });
});
