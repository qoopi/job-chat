import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileRow, Store, User } from "@shared/store";
import type { Profile, Skill } from "@shared/profile";

// The profile server actions' boundary logic: signed-in-only + conversation ownership + the PDF size cap
// + the empty guard, plus the sanitized poll read (never the transient PDF bytes). Exercises the REAL
// actions against a fake Store, mocking only the framework boundaries actions.ts wires at module scope.

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore.has(name) ? { value: cookieStore.get(name)! } : undefined),
    delete: () => {},
    set: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("postgres", () => ({ default: () => ({}) }));

const triggerMock = vi.fn(async () => ({ id: "run_1" }));
const runsRetrieveMock = vi.fn(async (): Promise<{ status: string }> => ({ status: "EXECUTING" }));
vi.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: vi.fn() },
  sessions: { open: vi.fn() },
  tasks: { trigger: (...args: unknown[]) => triggerMock(...(args as [])) },
  runs: { retrieve: (...args: unknown[]) => runsRetrieveMock(...(args as [])) },
}));
vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: { createStartSessionAction: () => vi.fn() },
}));

const getSessionMock = vi.fn(async (): Promise<{ user?: { id: string; name?: string } } | null> => null);
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: () => getSessionMock() } },
}));

let fakeStore: Store;
vi.mock("@shared/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/store")>();
  return { ...actual, createStore: () => fakeStore };
});

import {
  saveProfile,
  getMyProfile,
  deleteProfile,
  getProfileRunStatus,
  updateProfilePrefs,
  updateProfileSkills,
} from "@/app/actions";

const ACCT = "acct-1";
const AUTH = "auth-1";
const CONV = "11111111-2222-4333-8444-555555555555";

const PROFILE: Profile = {
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [{ name: "Go", source: "both" }],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 90000,
  yearsExp: 8,
  domains: ["fintech"],
  ossHighlights: [],
  experience: [],
  canonicalRoles: [],
};

function makeStore(overrides: Partial<Store> = {}): Store {
  const boom = () => {
    throw new Error("not used in this test");
  };
  const acctUser: User = { user_id: ACCT, created_at: new Date(), auth_user_id: AUTH };
  return {
    getOrCreateUser: boom,
    createConversation: boom,
    appendMessage: boom,
    getConversation: boom,
    findUserByAuthId: async (id: string) => (id === AUTH ? acctUser : null),
    getConversationOwner: async () => ({ user_id: ACCT, auth_user_id: AUTH }), // owned by the account
    linkAuthUser: boom,
    adoptGuest: boom,
    listConversations: boom,
    deleteConversation: boom,
    deleteTrailingAssistant: boom,
    appendProfileCard: boom,
    getProfile: boom,
    saveProfileInputs: boom,
    saveExtractedProfile: boom,
    updateProfilePrefs: boom,
    updateProfileSkills: boom,
    clearResumePdf: boom,
    markExtractionFailed: boom,
    deleteProfile: boom,
    deleteMessage: boom,
    messageCounts: boom,
    ...overrides,
  } as Store;
}

function signIn() {
  getSessionMock.mockResolvedValue({ user: { id: AUTH, name: "Jane" } });
}

beforeEach(() => {
  cookieStore.clear();
  delete process.env.JOBCHAT_E2E;
  triggerMock.mockClear();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(null); // guest by default
});
afterEach(() => vi.clearAllMocks());

describe("saveProfile", () => {
  it("refuses a guest (signed-in only, auth-first)", async () => {
    const saveProfileInputs = vi.fn();
    fakeStore = makeStore({ saveProfileInputs });
    const res = await saveProfile({ conversationId: CONV, resumeText: "hi" });
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
    expect(saveProfileInputs).not.toHaveBeenCalled();
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it("refuses a conversation the caller does not own", async () => {
    signIn();
    const saveProfileInputs = vi.fn();
    fakeStore = makeStore({
      getConversationOwner: async () => ({ user_id: "someone-else", auth_user_id: "other" }),
      saveProfileInputs,
    });
    const res = await saveProfile({ conversationId: CONV, resumeText: "hi" });
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
    expect(saveProfileInputs).not.toHaveBeenCalled();
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized resume PDF (too-large), never persisting or triggering", async () => {
    signIn();
    const saveProfileInputs = vi.fn();
    fakeStore = makeStore({ saveProfileInputs });
    const tooBig = Buffer.alloc(Math.floor(4.5 * 1024 * 1024) + 1).toString("base64");
    const res = await saveProfile({ conversationId: CONV, resumePdf: { bytes: tooBig, name: "big.pdf" } });
    expect(res).toEqual({ ok: false, reason: "too-large" });
    expect(saveProfileInputs).not.toHaveBeenCalled();
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it("refuses an entirely empty save (empty)", async () => {
    signIn();
    fakeStore = makeStore({ saveProfileInputs: vi.fn() });
    const res = await saveProfile({ conversationId: CONV, resumeText: "   ", githubUsername: "" });
    expect(res).toEqual({ ok: false, reason: "empty" });
  });

  it("stores inputs and triggers the extract task on the happy path", async () => {
    signIn();
    const saveProfileInputs = vi.fn(async () => {});
    fakeStore = makeStore({ saveProfileInputs });
    const res = await saveProfile({
      conversationId: CONV,
      resumeText: "Senior backend engineer",
      githubUsername: "  octocat  ",
    });
    expect(res).toEqual({ ok: true, taskState: "queued", runId: "run_1" });
    expect(saveProfileInputs).toHaveBeenCalledWith({
      userId: ACCT,
      rawResumeText: "Senior backend engineer",
      resumePdf: null,
      githubUsername: "octocat", // trimmed
    });
    expect(triggerMock).toHaveBeenCalledWith("extract-profile", { userId: ACCT, conversationId: CONV });
  });

  it("returns a typed enqueue-failed (not a 500) when the task enqueue throws", async () => {
    // The inputs were already stored; if the trigger enqueue fails, the action must not throw untyped
    // (a client 500) - it returns a typed reason so the client can surface a retry (nit).
    signIn();
    const saveProfileInputs = vi.fn(async () => {});
    fakeStore = makeStore({ saveProfileInputs });
    triggerMock.mockRejectedValueOnce(new Error("trigger unavailable"));
    const res = await saveProfile({ conversationId: CONV, resumeText: "Senior backend engineer" });
    expect(res).toEqual({ ok: false, reason: "enqueue-failed" });
    expect(saveProfileInputs).toHaveBeenCalled(); // inputs stored (the client can re-save)
  });
});

describe("getMyProfile", () => {
  it("returns null for a guest", async () => {
    fakeStore = makeStore();
    expect(await getMyProfile()).toBeNull();
  });

  it("returns the sanitized profile (never the PDF bytes) for a signed-in caller", async () => {
    signIn();
    const extractedAt = new Date("2026-07-22T10:00:00Z");
    const row: ProfileRow = {
      user_id: ACCT,
      raw_resume_text: "secret resume text",
      resume_pdf: new Uint8Array([1, 2, 3]), // MUST NOT leak to the client
      github_username: "octocat",
      profile: PROFILE,
      extracted_at: extractedAt,
      extraction_failed: false,
    };
    fakeStore = makeStore({ getProfile: async () => row });
    const res = await getMyProfile();
    expect(res).toEqual({ profile: PROFILE, githubUsername: "octocat", extractedAt: extractedAt.toISOString(), extractionFailed: false });
    expect(JSON.stringify(res)).not.toContain("resume"); // no raw text / pdf bytes in the DTO
  });

  it("returns null when the signed-in caller has no profile row", async () => {
    signIn();
    fakeStore = makeStore({ getProfile: async () => null });
    expect(await getMyProfile()).toBeNull();
  });
});

describe("deleteProfile", () => {
  it("refuses a guest and does not touch the store", async () => {
    const del = vi.fn();
    fakeStore = makeStore({ deleteProfile: del });
    expect(await deleteProfile()).toEqual({ ok: false });
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes the signed-in caller's profile row", async () => {
    signIn();
    const del = vi.fn(async () => {});
    fakeStore = makeStore({ deleteProfile: del });
    expect(await deleteProfile()).toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith(ACCT);
  });

  // 041 req 3: the streamed profile card stays as history - delete-profile never rewrites past turns, so it
  // never touches the messages (the PROFILE note leaves the agent context on its own, per-turn owner-context).
  it("leaves the streamed profile card untouched (history is history) - never deletes a message", async () => {
    signIn();
    const deleteMessage = vi.fn();
    fakeStore = makeStore({ deleteProfile: vi.fn(async () => {}), deleteMessage });
    await deleteProfile();
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});

describe("updateProfilePrefs", () => {
  it("refuses a guest (not_found) and never touches the store", async () => {
    const upd = vi.fn();
    fakeStore = makeStore({ updateProfilePrefs: upd });
    expect(await updateProfilePrefs({ salary: 100000, location: "SF" })).toEqual({ ok: false, reason: "not_found" });
    expect(upd).not.toHaveBeenCalled();
  });

  it("parses the location + persists the prefs, returning the updated row", async () => {
    signIn();
    const updated: Profile = { ...PROFILE, salaryMin: 150000, locations: ["SF"], remotePref: true };
    const upd = vi.fn(async () => updated);
    fakeStore = makeStore({ updateProfilePrefs: upd });
    const res = await updateProfilePrefs({ salary: 150000, location: "SF or remote" });
    expect(res).toEqual({ ok: true, profile: updated });
    expect(upd).toHaveBeenCalledWith(ACCT, { salaryMin: 150000, locations: ["SF"], remotePref: true });
  });

  it("clears both prefs when salary is null and location is blank", async () => {
    signIn();
    const upd = vi.fn(async () => ({ ...PROFILE, salaryMin: null, locations: [], remotePref: null }));
    fakeStore = makeStore({ updateProfilePrefs: upd });
    await updateProfilePrefs({ salary: null, location: "   " });
    expect(upd).toHaveBeenCalledWith(ACCT, { salaryMin: null, locations: [], remotePref: null });
  });

  it("rejects a non-positive / non-integer / over-cap salary (invalid_input), never persisting", async () => {
    signIn();
    const upd = vi.fn();
    fakeStore = makeStore({ updateProfilePrefs: upd });
    for (const salary of [0, -5, 1.5, 10_000_001]) {
      expect(await updateProfilePrefs({ salary, location: null })).toEqual({ ok: false, reason: "invalid_input" });
    }
    expect(upd).not.toHaveBeenCalled();
  });

  it("rejects location text over the 120 cap (invalid_input), never persisting", async () => {
    signIn();
    const upd = vi.fn();
    fakeStore = makeStore({ updateProfilePrefs: upd });
    expect(await updateProfilePrefs({ salary: null, location: "x".repeat(121) })).toEqual({ ok: false, reason: "invalid_input" });
    expect(upd).not.toHaveBeenCalled();
  });

  it("returns not_found when the caller has no extracted profile row (store -> null)", async () => {
    signIn();
    fakeStore = makeStore({ updateProfilePrefs: async () => null });
    expect(await updateProfilePrefs({ salary: 100000, location: "SF" })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("updateProfileSkills", () => {
  const SKILLS: Skill[] = [
    { name: "Go", source: "both" },
    { name: "ClickHouse", source: "github" },
    { name: "Rust", source: "resume" },
  ];

  it("refuses a guest (not_found) and never touches the store", async () => {
    const upd = vi.fn();
    fakeStore = makeStore({ updateProfileSkills: upd });
    expect(await updateProfileSkills({ skills: SKILLS })).toEqual({ ok: false, reason: "not_found" });
    expect(upd).not.toHaveBeenCalled();
  });

  it("trims names, drops empties, dedupes case-insensitively (first wins, source preserved); returns the row", async () => {
    signIn();
    const updated: Profile = { ...PROFILE, skills: [{ name: "Go", source: "both" }, { name: "Rust", source: "resume" }] };
    const upd = vi.fn(async () => updated);
    fakeStore = makeStore({ updateProfileSkills: upd });
    const res = await updateProfileSkills({
      skills: [
        { name: "  Go  ", source: "both" },
        { name: "", source: "resume" }, // dropped
        { name: "go", source: "github" }, // dup of Go -> dropped, first (both) wins
        { name: "Rust", source: "resume" },
      ],
    });
    expect(res).toEqual({ ok: true, profile: updated });
    expect(upd).toHaveBeenCalledWith(ACCT, [
      { name: "Go", source: "both" },
      { name: "Rust", source: "resume" },
    ]);
  });

  it("allows removing every github-proven chip - an empty array persists (the user owns their profile)", async () => {
    signIn();
    const upd = vi.fn(async () => ({ ...PROFILE, skills: [] }));
    fakeStore = makeStore({ updateProfileSkills: upd });
    await updateProfileSkills({ skills: [] });
    expect(upd).toHaveBeenCalledWith(ACCT, []);
  });

  it("rejects a skill name over 60 chars (invalid_input), never persisting", async () => {
    signIn();
    const upd = vi.fn();
    fakeStore = makeStore({ updateProfileSkills: upd });
    expect(await updateProfileSkills({ skills: [{ name: "x".repeat(61), source: "resume" }] })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(upd).not.toHaveBeenCalled();
  });

  it("rejects more than 40 skills (invalid_input)", async () => {
    signIn();
    const upd = vi.fn();
    fakeStore = makeStore({ updateProfileSkills: upd });
    const many: Skill[] = Array.from({ length: 41 }, (_, i) => ({ name: `skill-${i}`, source: "resume" }));
    expect(await updateProfileSkills({ skills: many })).toEqual({ ok: false, reason: "invalid_input" });
    expect(upd).not.toHaveBeenCalled();
  });

  it("rejects an invalid source from an untrusted client (invalid_input)", async () => {
    signIn();
    const upd = vi.fn();
    fakeStore = makeStore({ updateProfileSkills: upd });
    // @ts-expect-error - deliberately malformed source
    expect(await updateProfileSkills({ skills: [{ name: "Go", source: "linkedin" }] })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(upd).not.toHaveBeenCalled();
  });

  it("returns not_found when the caller has no extracted profile row (store -> null)", async () => {
    signIn();
    fakeStore = makeStore({ updateProfileSkills: async () => null });
    expect(await updateProfileSkills({ skills: SKILLS })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("getProfileRunStatus", () => {
  it("maps COMPLETED -> done", async () => {
    runsRetrieveMock.mockResolvedValueOnce({ status: "COMPLETED" });
    expect(await getProfileRunStatus("run_1")).toEqual({ status: "done" });
  });
  it("maps a terminal failure status -> failed (the re-save-edge backstop)", async () => {
    runsRetrieveMock.mockResolvedValueOnce({ status: "FAILED" });
    expect(await getProfileRunStatus("run_1")).toEqual({ status: "failed" });
  });
  it("maps an in-flight status -> pending", async () => {
    runsRetrieveMock.mockResolvedValueOnce({ status: "EXECUTING" });
    expect(await getProfileRunStatus("run_1")).toEqual({ status: "pending" });
  });
  it("treats a retrieve error as pending (never terminates the poll early)", async () => {
    runsRetrieveMock.mockRejectedValueOnce(new Error("transient"));
    expect(await getProfileRunStatus("run_1")).toEqual({ status: "pending" });
  });
});
