import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";

// The saveProfile action's ownership check, integration against REAL Postgres (contrast
// tests/unit/profile-actions.test.ts, which exercises the same action against a fake Store). Only the
// Next.js/Trigger.dev framework boundaries are mocked here; @shared/store and `postgres` are real, so
// `getConversationOwner` runs a genuine query against a genuine cross-account conversation. Skipped
// without DATABASE_URL.
const hasCreds = Boolean(process.env.DATABASE_URL);

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, delete: () => {}, set: () => {} }),
  headers: async () => new Headers(),
}));

const triggerMock = vi.fn(async () => ({ id: "run_1" }));
vi.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: vi.fn() },
  sessions: { open: vi.fn() },
  tasks: { trigger: (...args: unknown[]) => triggerMock(...(args as [])) },
}));
vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: { createStartSessionAction: () => vi.fn() },
}));

const getSessionMock = vi.fn(async (): Promise<{ user?: { id: string } } | null> => null);
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: () => getSessionMock() } },
}));

describe.skipIf(!hasCreds)("saveProfile ownership against real Postgres", () => {
  let sql: Sql;
  let store: Store;
  const guests: string[] = [];

  function freshGuestId(): string {
    const id = `test-guest-${crypto.randomUUID()}`;
    guests.push(id);
    return id;
  }

  async function signInAs(authUserId: string) {
    getSessionMock.mockResolvedValue({ user: { id: authUserId } });
  }

  async function purge(user: string) {
    await sql`DELETE FROM messages m USING conversations cv
              WHERE m.conversation_id = cv.id AND cv.user_id = ${user}`;
    await sql`DELETE FROM conversations WHERE user_id = ${user}`;
    await sql`DELETE FROM profiles WHERE user_id = ${user}`;
    await sql`DELETE FROM users WHERE user_id = ${user}`;
  }

  beforeAll(() => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    store = createStore(sql);
  });

  afterEach(async () => {
    triggerMock.mockClear();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue(null);
    for (const g of guests.splice(0)) await purge(g);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("refuses a real cross-account conversationId with unauthorized: no profile row, no trigger (AC ownership)", async () => {
    const { saveProfile } = await import("@/app/actions");

    const owner = freshGuestId();
    const ownerAuth = `auth-${crypto.randomUUID()}`;
    await store.getOrCreateUser(owner);
    await store.linkAuthUser(owner, ownerAuth);
    const conv = await store.createConversation(owner, "owner's real conversation");

    const attacker = freshGuestId();
    const attackerAuth = `auth-${crypto.randomUUID()}`;
    await store.getOrCreateUser(attacker);
    await store.linkAuthUser(attacker, attackerAuth);

    await signInAs(attackerAuth); // signed in as the ATTACKER, targeting the owner's real conversation
    const res = await saveProfile({ conversationId: conv.id, resumeText: "stolen resume text" });

    expect(res).toEqual({ ok: false, reason: "unauthorized" });
    expect(await store.getProfile(attacker)).toBeNull(); // nothing was persisted for the attacker
    expect(triggerMock).not.toHaveBeenCalled(); // the extraction task never queued
  });

  it("the real owner's save on their own conversation is accepted (ownership check does not over-refuse)", async () => {
    const { saveProfile } = await import("@/app/actions");

    const owner = freshGuestId();
    const ownerAuth = `auth-${crypto.randomUUID()}`;
    await store.getOrCreateUser(owner);
    await store.linkAuthUser(owner, ownerAuth);
    const conv = await store.createConversation(owner, "owner's real conversation");

    await signInAs(ownerAuth);
    const res = await saveProfile({ conversationId: conv.id, resumeText: "my real resume" });

    expect(res).toEqual({ ok: true, taskState: "queued", runId: "run_1" });
    const row = await store.getProfile(owner);
    expect(row?.raw_resume_text).toBe("my real resume"); // really persisted, via the real store
    expect(triggerMock).toHaveBeenCalledWith("extract-profile", { userId: owner, conversationId: conv.id });
  });
});
