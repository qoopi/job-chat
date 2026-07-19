import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import { createSessionService, type StartSession } from "../../trigger/session";

// Strand 2 guards + landing handoff, integration against real Postgres. The session service is the
// injectable core the "use server" actions wrap: it counts messages for the cap/budget, refuses with
// a TYPED reason (no throws for business outcomes), and only then persists the user turn + triggers
// the run. Skipped without creds.
const hasCreds = Boolean(process.env.DATABASE_URL);
const HUGE = Number.MAX_SAFE_INTEGER; // a budget high enough that shared same-day rows never trip it

describe.skipIf(!hasCreds)("session service against real Postgres", () => {
  let sql: Sql;
  let store: Store;
  const guests: string[] = [];

  function freshGuestId(): string {
    const id = `test-guest-${crypto.randomUUID()}`;
    guests.push(id);
    return id;
  }

  function okStartSession(): StartSession {
    return vi.fn(async () => ({ publicAccessToken: "pat_test", runId: "run_test", sessionId: "session_test" }));
  }

  async function purge(user: string) {
    await sql`DELETE FROM messages m USING conversations cv
              WHERE m.conversation_id = cv.id AND cv.user_id = ${user}`;
    await sql`DELETE FROM conversations WHERE user_id = ${user}`;
    await sql`DELETE FROM users WHERE user_id = ${user}`;
  }

  beforeAll(() => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    store = createStore(sql);
  });

  afterEach(async () => {
    for (const g of guests.splice(0)) await purge(g);
  });

  afterAll(async () => {
    await sql.end();
  });

  // AC-3 server slice: the landing handoff creates the conversation + user message #1 and triggers
  // the run, returning the id + a session-scoped token for the browser.
  it("startConversation creates the conversation + user message and triggers the run (AC-3)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const startSession = okStartSession();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      startSession,
      now: () => new Date(),
    });

    const res = await svc.startConversation(userId, "  What is the median salary in SF?  ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conversationId).toBeTruthy();
    expect(res.publicAccessToken).toBe("pat_test");
    expect(res.runId).toBe("run_test");
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ chatId: res.conversationId }));

    const reloaded = await store.getConversation(res.conversationId);
    expect(reloaded?.conversation.title).toBe("What is the median salary in SF?"); // derived, trimmed
    expect(reloaded?.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "  What is the median salary in SF?  "],
    ]);
  });

  // AC-15: the (cap+1)-th user message is refused with a typed reason, before any trigger.
  it("sendMessage refuses with guest_cap once the guest hits the cap (AC-15)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "cap check");
    const cap = 10;
    for (let i = 0; i < cap; i++) await store.appendMessage(conv.id, "user", `msg ${i}`, null);

    const startSession = okStartSession();
    const svc = createSessionService({
      store,
      guards: { guestCap: cap, dailyBudget: HUGE },
      startSession,
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "one too many");
    expect(res).toEqual({ ok: false, reason: "guest_cap" });
    expect(startSession).not.toHaveBeenCalled();
    // The refused message was NOT persisted (still exactly `cap` user turns).
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(cap);
  });

  // AC-20: the global daily budget is the kill switch - a fresh guest is refused even on message #1.
  it("refuses every guest with daily_budget when the global budget is exhausted (AC-20)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const startSession = okStartSession();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: 0 }, // 0 = exhausted: refuse all
      startSession,
      now: () => new Date(),
    });

    const res = await svc.startConversation(userId, "anything at all");
    expect(res).toEqual({ ok: false, reason: "daily_budget" });
    expect(startSession).not.toHaveBeenCalled();
    // Nothing was created for the refused guest.
    const count = await sql`SELECT count(*)::int AS c FROM conversations WHERE user_id = ${userId}`;
    expect(count[0].c).toBe(0);
  });

  it("sendMessage returns not_found for an unknown conversation id", async () => {
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      startSession: okStartSession(),
      now: () => new Date(),
    });
    expect(await svc.sendMessage(crypto.randomUUID(), "hi")).toEqual({ ok: false, reason: "not_found" });
  });
});
