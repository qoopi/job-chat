import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import { createSessionService, type MintToken, type StartSession } from "../../trigger/session";

// Strand 2 guards + landing handoff, integration against real Postgres. The session service is the
// injectable core the "use server" actions wrap: it bounds untrusted input, confirms the caller owns
// the conversation, counts messages for the cap/budget, refuses with a TYPED reason (no throws for
// business outcomes), and only then persists the user turn + triggers the run. Skipped without creds.
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
  function okMintToken(): MintToken {
    return vi.fn(async (conversationId: string) => `pat_${conversationId}`);
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
      mintToken: okMintToken(),
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
      ["user", "  What is the median salary in SF?  "], // ORIGINAL text persisted, not the trimmed form
    ]);
  });

  // must-fix B: unbounded input is refused at the boundary before any store write or trigger.
  it("startConversation refuses over-long input (invalid_input) before any persist or trigger", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const startSession = okStartSession();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      startSession,
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.startConversation(userId, "x".repeat(2001));
    expect(res).toEqual({ ok: false, reason: "invalid_input" });
    expect(startSession).not.toHaveBeenCalled();
    const count = await sql`SELECT count(*)::int AS c FROM conversations WHERE user_id = ${userId}`;
    expect(count[0].c).toBe(0); // nothing created
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
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "one too many", userId);
    expect(res).toEqual({ ok: false, reason: "guest_cap" });
    expect(startSession).not.toHaveBeenCalled();
    // The refused message was NOT persisted (still exactly `cap` user turns).
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(cap);
  });

  // should-fix ownership: Guest B, handed Guest A's conversation id, cannot inject a message or
  // trigger a paid run in it - it reads as not_found (before the OLD code discarded the caller and
  // enforced the guard against the OWNER, letting the injection through).
  it("sendMessage refuses a cross-guest conversation with not_found (ownership)", async () => {
    const owner = freshGuestId();
    const attacker = freshGuestId();
    await store.getOrCreateUser(owner);
    await store.getOrCreateUser(attacker);
    const conv = await store.createConversation(owner, "owner's thread");

    const startSession = okStartSession();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      startSession,
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "injected", attacker);
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(startSession).not.toHaveBeenCalled();
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(0); // nothing injected
  });

  it("sendMessage succeeds for the conversation's owner", async () => {
    const owner = freshGuestId();
    await store.getOrCreateUser(owner);
    const conv = await store.createConversation(owner, "owner's thread");

    const startSession = okStartSession();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      startSession,
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "a real follow-up", owner);
    expect(res.ok).toBe(true);
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ chatId: conv.id }));
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.map((m) => m.content)).toContain("a real follow-up");
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
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.startConversation(userId, "anything at all");
    expect(res).toEqual({ ok: false, reason: "daily_budget" });
    expect(startSession).not.toHaveBeenCalled();
    // Nothing was created for the refused guest.
    const count = await sql`SELECT count(*)::int AS c FROM conversations WHERE user_id = ${userId}`;
    expect(count[0].c).toBe(0);
  });

  // AC-20 cross-user check: the budget must be a GLOBAL count, not accidentally scoped to the caller.
  // A fresh guest with zero messages of their own is still refused once ANOTHER guest's traffic alone
  // exhausts the shared budget - this fails if `messageCounts` for the budget check were ever scoped
  // by userId (a fresh guest would then read 0 and wrongly be allowed through).
  it("refuses a fresh guest once OTHER guests' messages exhaust the shared daily budget (AC-20 cross-user)", async () => {
    const noisyGuest = freshGuestId();
    await store.getOrCreateUser(noisyGuest);
    const noisyConv = await store.createConversation(noisyGuest, "seed");
    const budget = 3;
    for (let i = 0; i < budget; i++) await store.appendMessage(noisyConv.id, "user", `seed ${i}`, null);

    const freshGuest = freshGuestId();
    await store.getOrCreateUser(freshGuest);
    const startSession = okStartSession();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: budget }, // exhausted by noisyGuest alone
      startSession,
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.startConversation(freshGuest, "anything at all");
    expect(res).toEqual({ ok: false, reason: "daily_budget" });
    expect(startSession).not.toHaveBeenCalled();
  });

  it("sendMessage returns not_found for an unknown conversation id", async () => {
    const guestId = freshGuestId();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      startSession: okStartSession(),
      mintToken: okMintToken(),
      now: () => new Date(),
    });
    expect(await svc.sendMessage(crypto.randomUUID(), "hi", guestId)).toEqual({ ok: false, reason: "not_found" });
  });

  // should-fix ownership (mint side): a token is minted only for the caller's OWN conversation.
  it("mintChatToken mints for the owner but refuses a cross-guest conversation (not_found)", async () => {
    const owner = freshGuestId();
    const attacker = freshGuestId();
    await store.getOrCreateUser(owner);
    await store.getOrCreateUser(attacker);
    const conv = await store.createConversation(owner, "owner's thread");
    const mintToken = okMintToken();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      startSession: okStartSession(),
      mintToken,
      now: () => new Date(),
    });

    expect(await svc.mintChatToken(conv.id, owner)).toEqual({ ok: true, token: `pat_${conv.id}` });
    expect(await svc.mintChatToken(conv.id, attacker)).toEqual({ ok: false, reason: "not_found" });
    expect(mintToken).toHaveBeenCalledTimes(1); // never minted for the attacker
  });
});
