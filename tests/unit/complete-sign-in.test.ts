import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store, User } from "@shared/store";

// Audit focus (013 testing pass): the sign-in TRANSITION's cookie-clear MUST be sequenced strictly
// after a successful adoption - a failed `resolveIdentity` must neither clear the guest cookie nor
// swallow the error (the client's queued-draft flow relies on the rejection to keep the dialog open
// and the draft queued; see queued-draft.test.tsx). This exercises the REAL `completeSignIn` +
// `resolveIdentity` (trigger/session.ts) against a fake in-memory Store, mocking only the framework
// boundaries (next/headers, postgres, Trigger.dev SDK, Better Auth) actions.ts wires at module scope.

const cookieStore = new Map<string, string>();
const deleteCookieMock = vi.fn((name: string) => cookieStore.delete(name));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore.has(name) ? { value: cookieStore.get(name)! } : undefined),
    delete: (name: string) => deleteCookieMock(name),
  }),
  headers: async () => new Headers(),
}));

vi.mock("postgres", () => ({ default: () => ({}) }));
vi.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: vi.fn() },
  sessions: { open: vi.fn() },
}));
vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: { createStartSessionAction: () => vi.fn() },
}));

const getSessionMock = vi.fn(async (): Promise<{ user?: { id: string } } | null> => null);
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: () => getSessionMock() } },
}));

let fakeStore: Store;
vi.mock("@shared/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/store")>();
  return { ...actual, createStore: () => fakeStore };
});

const AUTH_USER_ID = "auth-user-1";
const GUEST_ID = "guest-1";

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
    messageCounts: boom,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
  delete process.env.JOBCHAT_E2E;
});

describe("completeSignIn cookie-clear sequencing (AC-11 ruling 1)", () => {
  it("Should_ClearGuestCookie_When_AdoptionSucceeds", async () => {
    cookieStore.set("jobchat_guest", GUEST_ID);
    getSessionMock.mockResolvedValue({ user: { id: AUTH_USER_ID } });
    const existing: User = { user_id: "account-1", created_at: new Date(), auth_user_id: AUTH_USER_ID };
    const adoptGuest = vi.fn(async () => {});
    fakeStore = makeStore({
      findUserByAuthId: async () => existing,
      adoptGuest,
    });

    const { completeSignIn } = await import("@/app/actions");
    const result = await completeSignIn();

    expect(result).toEqual({ ok: true });
    expect(adoptGuest).toHaveBeenCalledWith("account-1", GUEST_ID); // adoption ran BEFORE the assertion below
    expect(deleteCookieMock).toHaveBeenCalledWith("jobchat_guest"); // cleared only after it succeeded
    expect(cookieStore.has("jobchat_guest")).toBe(false);
  });

  it("Should_NotClearGuestCookie_When_AdoptionFails", async () => {
    cookieStore.set("jobchat_guest", GUEST_ID);
    getSessionMock.mockResolvedValue({ user: { id: AUTH_USER_ID } });
    const existing: User = { user_id: "account-1", created_at: new Date(), auth_user_id: AUTH_USER_ID };
    fakeStore = makeStore({
      findUserByAuthId: async () => existing,
      adoptGuest: async () => {
        throw new Error("adoption store failure");
      },
    });

    const { completeSignIn } = await import("@/app/actions");

    await expect(completeSignIn()).rejects.toThrow("adoption store failure");
    // the failure must not be swallowed (the client's catch is what keeps the draft queued) and the
    // cookie must survive so the per-request path can still resolve the guest's conversations
    expect(deleteCookieMock).not.toHaveBeenCalled();
    expect(cookieStore.get("jobchat_guest")).toBe(GUEST_ID);
  });

  it("Should_NotClearCookieOrThrow_When_NoVerifiedSession", async () => {
    cookieStore.set("jobchat_guest", GUEST_ID);
    getSessionMock.mockResolvedValue(null); // no session yet (e.g. a stray call before sign-in completes)
    fakeStore = makeStore();

    const { completeSignIn } = await import("@/app/actions");
    const result = await completeSignIn();

    expect(result).toEqual({ ok: false });
    expect(deleteCookieMock).not.toHaveBeenCalled();
  });
});
