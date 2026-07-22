import { describe, expect, it, vi } from "vitest";
import {
  buildExtractionPrompt,
  extractProfileFields,
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

/** A fake store: getProfile returns the given row; records saveExtractedProfile + appendProfileCard. */
function fakeStore(row: ProfileRow | null) {
  const saved: Profile[] = [];
  const cards: { conversationId: string; id: string; parts: unknown }[] = [];
  const store = {
    getProfile: async () => row,
    saveExtractedProfile: async (_userId: string, profile: Profile) => {
      saved.push(profile);
    },
    appendProfileCard: async (conversationId: string, id: string, parts: unknown) => {
      cards.push({ conversationId, id, parts });
    },
  } as unknown as Store;
  return { store, saved, cards };
}

function row(overrides: Partial<ProfileRow>): ProfileRow {
  return {
    user_id: "u1",
    raw_resume_text: null,
    resume_pdf: null,
    github_username: null,
    profile: null,
    extracted_at: null,
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
});

describe("extractProfileFields", () => {
  it("retries once when the first generation fails, then returns the profile", async () => {
    const generate = vi
      .fn<GenerateProfile>()
      .mockRejectedValueOnce(new Error("invalid JSON"))
      .mockResolvedValueOnce(PROFILE);
    const result = await extractProfileFields(generate, { resumeText: "x" });
    expect(result).toEqual(PROFILE);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe("runProfileExtraction", () => {
  it("Should_ExtractFromPdfDocument_When_PdfUploaded: PDF -> document block -> saved + card appended (AC-4)", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { store, saved, cards } = fakeStore(row({ resume_pdf: pdf, github_username: "octocat" }));
    let seen: ExtractionMessage[] = [];
    const generate = vi.fn<GenerateProfile>(async ({ messages }) => {
      seen = messages;
      return PROFILE;
    });
    const fetchGithub = vi.fn(async () => signals());

    const result = await runProfileExtraction({ store, fetchGithub, generate, githubToken: "tok" }, { userId: "u1", conversationId: "c1" });

    expect(result).toEqual(PROFILE);
    expect(filePart(seen[0])).toMatchObject({ mediaType: "application/pdf" }); // the model got the document block
    expect(saved).toEqual([PROFILE]); // structured profile persisted (NULLs the transient PDF)
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(profileCardMessageId("c1")); // deterministic card id
    expect(cards[0].parts).toEqual({ kind: "profile-card", profile: PROFILE });
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
});
