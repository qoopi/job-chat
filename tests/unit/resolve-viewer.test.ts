import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store, User } from "@shared/store";

// The `/chat/[id]` resume gate now keys ownership on the resolved
// Viewer instead of the guest cookie alone. `resolveViewer` (server-store.ts)
// has NO existing test - this closes that gap at the unit level (the page.tsx wiring itself is covered
// by chat-page-resume-gate.test.ts, which mocks this module as the boundary). Mocks only the framework
// edges (next/headers, postgres, Better Auth); resolveViewer's own branching is real.

vi.mock("server-only", () => ({}));

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { value: cookieStore.get(name)! } : undefined,
  }),
  headers: async () => new Headers(),
}));

vi.mock("postgres", () => ({ default: () => ({}) }));

const getSessionMock = vi.fn(
  async (): Promise<{
    user?: { id: string; name?: string; email?: string };
  } | null> => null,
);
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: () => getSessionMock() } },
}));

let fakeStore: Store;
vi.mock("@shared/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/store")>();
  return { ...actual, createStore: () => fakeStore };
});

function makeStore(overrides: Partial<Store> = {}): Store {
  const boom = () => {
    throw new Error("not used in this test");
  };
  return {
    getOrCreateUser: boom,
    createConversation: boom,
    appendMessage: boom,
    getConversation: boom,
    getConversationOwner: boom,
    findUserByAuthId: boom,
    linkAuthUser: boom,
    adoptGuest: boom,
    listConversations: boom,
    deleteConversation: boom,
    renameConversation: boom,
    deleteTrailingAssistant: boom,
    appendProfileCard: boom,
    getProfile: boom,
    saveProfileInputs: boom,
    saveExtractedProfile: boom,
    updateProfilePrefs: boom,
    clearResumePdf: boom,
    markExtractionFailed: boom,
    deleteProfile: boom,
    deleteMessage: boom,
    messageCounts: boom,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
});

describe("resolveViewer (AC-14 / resume-gate ruling 2)", () => {
  it("Should_ResolveGuestOnly_When_NoSessionAndGuestCookiePresent", async () => {
    cookieStore.set("jobchat_guest", "guest-1");
    fakeStore = makeStore();

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer();

    expect(viewer).toEqual({
      signedIn: false,
      ownerIds: ["guest-1"],
      accountUserId: null,
      accountName: null,
      accountEmail: null,
    });
  });

  it("Should_ResolveNoOwner_When_NoCookieAndNoSession", async () => {
    fakeStore = makeStore();

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer();

    expect(viewer).toEqual({
      signedIn: false,
      ownerIds: [],
      accountUserId: null,
      accountName: null,
      accountEmail: null,
    });
  });

  it("Should_ResolveAccountOwnership_When_SignedInWithLinkedRow", async () => {
    // No guest cookie on THIS device - a signed-in account resuming on a fresh device.
    getSessionMock.mockResolvedValue({ user: { id: "auth-1", name: "Ada" } });
    fakeStore = makeStore({
      findUserByAuthId: async (authUserId) =>
        authUserId === "auth-1"
          ? ({
              user_id: "account-1",
              created_at: new Date(),
              auth_user_id: "auth-1",
            } as User)
          : null,
    });

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer();

    expect(viewer).toEqual({
      signedIn: true,
      ownerIds: ["account-1"],
      accountUserId: "account-1",
      accountName: "Ada",
      accountEmail: null, // this session carries a name but no email
    });
  });

  it("Should_ExposeAccountEmail_When_SessionCarriesOne (refresh #2 s4 account-menu header)", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "auth-1", name: "Ada", email: "ada@example.com" },
    });
    fakeStore = makeStore({
      findUserByAuthId: async () => ({
        user_id: "account-1",
        created_at: new Date(),
        auth_user_id: "auth-1",
      }),
    });

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer();

    expect(viewer.accountEmail).toBe("ada@example.com");
    expect(viewer.accountName).toBe("Ada");
  });

  it("Should_IncludeBothOwnerIds_When_SignedInWithADistinctGuestCookieOnThisDevice", async () => {
    // Signed in AND a stray guest cookie from this browser (e.g. a fresh `ensureGuest` mint after
    // sign-in) - both ids may resume; the account id is deduped, not doubled.
    cookieStore.set("jobchat_guest", "guest-2");
    getSessionMock.mockResolvedValue({ user: { id: "auth-1" } });
    fakeStore = makeStore({
      findUserByAuthId: async () => ({
        user_id: "account-1",
        created_at: new Date(),
        auth_user_id: "auth-1",
      }),
    });

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer();

    expect(viewer.ownerIds).toEqual(["guest-2", "account-1"]);
  });

  it("Should_NotDedupeAwayGuestId_When_AccountRowIsTheSameIdAsTheGuestCookie", async () => {
    // First sign-in this browser: adoption already stamped auth_user_id onto the guest's OWN row, so
    // the account's user_id equals the guest cookie's id - must appear exactly once, not omitted.
    cookieStore.set("jobchat_guest", "guest-3");
    getSessionMock.mockResolvedValue({ user: { id: "auth-1" } });
    fakeStore = makeStore({
      findUserByAuthId: async () => ({
        user_id: "guest-3",
        created_at: new Date(),
        auth_user_id: "auth-1",
      }),
    });

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer();

    expect(viewer.ownerIds).toEqual(["guest-3"]);
  });

  it("Should_DegradeToGuestOnly_When_AuthSessionLookupThrows", async () => {
    cookieStore.set("jobchat_guest", "guest-4");
    getSessionMock.mockRejectedValue(new Error("Better Auth misconfigured"));
    fakeStore = makeStore();

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer(); // must never throw - a misconfig must not break the resume render

    expect(viewer).toEqual({
      signedIn: false,
      ownerIds: ["guest-4"],
      accountUserId: null,
      accountName: null,
      accountEmail: null,
    });
  });

  it("Should_ResolveNoAccountOwnership_When_SignedInButNotYetLinked", async () => {
    // Signed in, but resolveIdentity/linkAuthUser has not run yet for this session (a lag or a race) -
    // signedIn is true (for the UI), but ownerIds must NOT gain an unresolved account id.
    getSessionMock.mockResolvedValue({ user: { id: "auth-1" } });
    fakeStore = makeStore({ findUserByAuthId: async () => null });

    const { resolveViewer } = await import("@/lib/server-store");
    const viewer = await resolveViewer();

    expect(viewer).toEqual({
      signedIn: true,
      ownerIds: [],
      accountUserId: null,
      accountName: null,
      accountEmail: null,
    });
  });
});
