import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import {
  createSessionService,
  resolveIdentity,
  type MintToken,
} from "../../trigger/session";

// Guards + landing handoff, integration against real Postgres. The session service is the
// injectable core the "use server" actions wrap: it bounds untrusted input, confirms the caller owns
// the conversation, counts messages for the cap/budget, and refuses with a TYPED reason (no throws for
// business outcomes). Turn 1 persists message #1 (no server-side trigger - the client's send path
// delivers it); a follow-up is a pure gate. Skipped without creds.
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

  // The landing handoff creates the conversation + persists user message #1 and
  // returns the id + the persisted message's id. It does NOT trigger a run - turn 1 rides the client's
  // public send path (the transport lazily starts the session on the first sendMessage).
  it("startConversation creates the conversation + user message and returns its id (no server-side trigger) (AC-11)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.startConversation(userId, "  What is the median salary in SF?  ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.conversationId).toBeTruthy();
    expect(res.messageId).toBeTruthy();

    const reloaded = await store.getConversation(res.conversationId);
    expect(reloaded?.conversation.title).toBe("What is the median salary in SF?"); // derived, trimmed
    expect(reloaded?.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "  What is the median salary in SF?  "], // ORIGINAL text persisted, not the trimmed form
    ]);
    // The returned messageId is exactly the persisted message #1 (id continuity for the client's send).
    expect(reloaded?.messages[0]?.id).toBe(res.messageId);
  });

  // A follow-up is a pure GATE. It does NOT persist, trigger, mint, or deliver
  // server-side - the client transport's `sendMessages` delivers the turn to `.in` (triggering the run)
  // and subscribes with wait (the only SDK path that streams a freshly-triggered follow-up live), and the
  // agent's `run()` persists the user turn before the backstop counts it.
  it("sendMessage GATES the follow-up: returns { ok: true } without persisting / triggering / minting (mechanism a)", async () => {
    const owner = freshGuestId();
    await store.getOrCreateUser(owner);
    const conv = await store.createConversation(owner, "owner's thread");
    const mintToken = okMintToken();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken,
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "and how about salaries?", owner);
    expect(res).toEqual({ ok: true });
    // No token minted on the send path (the transport's accessToken callback owns re-minting).
    expect(mintToken).not.toHaveBeenCalled();
    // Nothing persisted server-side: run() is the single persist site for the follow-up turn.
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(0);
  });

  // A refused turn (over cap) persists nothing - the guard short-circuits with a typed reason.
  it("does NOT persist when the turn is refused (guest_cap)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "cap check");
    const cap = 3;
    for (let i = 0; i < cap; i++) await store.appendMessage(conv.id, "user", `msg ${i}`, null);
    const svc = createSessionService({
      store,
      guards: { guestCap: cap, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "one too many", userId);
    expect(res).toEqual({ ok: false, reason: "guest_cap" });
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(cap); // nothing added
  });

  // Unbounded input is refused at the boundary before any store write.
  it("startConversation refuses over-long input (invalid_input) before any persist", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.startConversation(userId, "x".repeat(2001));
    expect(res).toEqual({ ok: false, reason: "invalid_input" });
    const count = await sql`SELECT count(*)::int AS c FROM conversations WHERE user_id = ${userId}`;
    expect(count[0].c).toBe(0); // nothing created
  });

  // The landing handoff (startConversation) is turn 1 for a BRAND NEW
  // conversation - a guest who already exhausted their per-day guestCap in an EARLIER conversation must
  // still be refused HERE, before any row for the new conversation is created (checkMessageGuards scopes
  // the cap per userId across ALL of the guest's conversations, not per-conversation, so this is not the
  // same case as the invalid_input/daily_budget pre-create tests above). Guest-cap refusal on landing
  // must keep working per the epic's Technical details.
  it("startConversation refuses with guest_cap BEFORE creating anything, when the guest already exhausted their cap in an earlier conversation", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const priorConv = await store.createConversation(userId, "earlier thread");
    const cap = 3;
    for (let i = 0; i < cap; i++) await store.appendMessage(priorConv.id, "user", `msg ${i}`, null);
    const svc = createSessionService({
      store,
      guards: { guestCap: cap, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const before = await sql`SELECT count(*)::int AS c FROM conversations WHERE user_id = ${userId}`;
    expect(before[0].c).toBe(1); // just the earlier conversation

    const res = await svc.startConversation(userId, "a brand new question");
    expect(res).toEqual({ ok: false, reason: "guest_cap" });
    // No NEW conversation row was created for the refused landing attempt.
    const after = await sql`SELECT count(*)::int AS c FROM conversations WHERE user_id = ${userId}`;
    expect(after[0].c).toBe(1); // still just the earlier one
  });

  // The (cap+1)-th user message is refused with a typed reason.
  it("sendMessage refuses with guest_cap once the guest hits the cap (AC-15)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "cap check");
    const cap = 10;
    for (let i = 0; i < cap; i++) await store.appendMessage(conv.id, "user", `msg ${i}`, null);

    const svc = createSessionService({
      store,
      guards: { guestCap: cap, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "one too many", userId);
    expect(res).toEqual({ ok: false, reason: "guest_cap" });
    // The refused message was NOT persisted (still exactly `cap` user turns).
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(cap);
  });

  // Ownership: Guest B, handed Guest A's conversation id, cannot inject a message in it - it
  // reads as not_found (before the OLD code discarded the caller and enforced the guard against the
  // OWNER, letting the injection through).
  it("sendMessage refuses a cross-guest conversation with not_found (ownership)", async () => {
    const owner = freshGuestId();
    const attacker = freshGuestId();
    await store.getOrCreateUser(owner);
    await store.getOrCreateUser(attacker);
    const conv = await store.createConversation(owner, "owner's thread");

    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "injected", attacker);
    expect(res).toEqual({ ok: false, reason: "not_found" });
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(0); // nothing injected
  });

  it("sendMessage gates through for the conversation's owner", async () => {
    const owner = freshGuestId();
    await store.getOrCreateUser(owner);
    const conv = await store.createConversation(owner, "owner's thread");

    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.sendMessage(conv.id, "a real follow-up", owner);
    expect(res).toEqual({ ok: true });
    // The owner's gate returns ok but does not persist (the client delivers).
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user")).toHaveLength(0);
  });

  // The global daily budget is the kill switch - a fresh guest is refused even on message #1.
  it("refuses every guest with daily_budget when the global budget is exhausted (AC-20)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: 0 }, // 0 = exhausted: refuse all
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.startConversation(userId, "anything at all");
    expect(res).toEqual({ ok: false, reason: "daily_budget" });
    // Nothing was created for the refused guest.
    const count = await sql`SELECT count(*)::int AS c FROM conversations WHERE user_id = ${userId}`;
    expect(count[0].c).toBe(0);
  });

  // Cross-user check: the budget must be a GLOBAL count, not accidentally scoped to the caller.
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
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: budget }, // exhausted by noisyGuest alone
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    const res = await svc.startConversation(freshGuest, "anything at all");
    expect(res).toEqual({ ok: false, reason: "daily_budget" });
  });

  it("sendMessage returns not_found for an unknown conversation id", async () => {
    const guestId = freshGuestId();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });
    expect(await svc.sendMessage(crypto.randomUUID(), "hi", guestId)).toEqual({ ok: false, reason: "not_found" });
  });

  // Parity with sendMessage above: an unknown (well-formed, never-created) id must refuse on the
  // mint-token layer too, not just when a real conversation is owned by someone else.
  it("mintChatToken returns not_found for an unknown conversation id", async () => {
    const guestId = freshGuestId();
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });
    expect(await svc.mintChatToken(crypto.randomUUID(), guestId)).toEqual({ ok: false, reason: "not_found" });
  });

  // Ownership (mint side): a token is minted only for the caller's OWN conversation.
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
      mintToken,
      now: () => new Date(),
    });

    expect(await svc.mintChatToken(conv.id, owner)).toEqual({ ok: true, token: `pat_${conv.id}` });
    expect(await svc.mintChatToken(conv.id, attacker)).toEqual({ ok: false, reason: "not_found" });
    expect(mintToken).toHaveBeenCalledTimes(1); // never minted for the attacker
  });

  // Account variant: ownership is by resolved userId, kind-agnostic. An account owner's
  // conversation is not_found to a DIFFERENT account (both refusal layers - sendMessage + mintChatToken)
  // and gates through for the owning account itself.
  it("refuses a not-owner ACCOUNT caller with not_found on both layers; owner gates through (AC-14)", async () => {
    const owner = freshGuestId();
    await store.getOrCreateUser(owner);
    await store.linkAuthUser(owner, `auth-${crypto.randomUUID()}`); // owner is a signed-in account
    const conv = await store.createConversation(owner, "owner's account thread");
    const attacker = freshGuestId();
    await store.getOrCreateUser(attacker);
    await store.linkAuthUser(attacker, `auth-${crypto.randomUUID()}`); // a DIFFERENT account
    const svc = createSessionService({
      store,
      guards: { guestCap: 10, dailyBudget: HUGE },
      mintToken: okMintToken(),
      now: () => new Date(),
    });

    expect(await svc.sendMessage(conv.id, "injected", attacker, "account")).toEqual({ ok: false, reason: "not_found" });
    expect(await svc.mintChatToken(conv.id, attacker)).toEqual({ ok: false, reason: "not_found" });
    expect(await svc.sendMessage(conv.id, "a real follow-up", owner, "account")).toEqual({ ok: true });
  });

  // deleteConversation is ownership-gated exactly like sendMessage/mintChatToken. A non-owner -
  // guest OR account - reads as not_found and the conversation survives; the owner's delete removes it.
  describe("deleteConversation ownership (AC-21)", () => {
    function svc() {
      return createSessionService({
        store,
        guards: { guestCap: 10, dailyBudget: HUGE },
        mintToken: okMintToken(),
        now: () => new Date(),
      });
    }

    it("Should_RefuseDelete_When_NotOwner: a cross-GUEST caller cannot delete another's conversation", async () => {
      const owner = freshGuestId();
      const attacker = freshGuestId();
      await store.getOrCreateUser(owner);
      await store.getOrCreateUser(attacker);
      const conv = await store.createConversation(owner, "owner's thread");

      expect(await svc().deleteConversation(conv.id, attacker)).toEqual({ ok: false, reason: "not_found" });
      expect(await store.getConversationOwner(conv.id)).not.toBeNull(); // still there, unmoved
    });

    it("Should_RefuseDelete_When_NotOwner: a cross-ACCOUNT caller cannot delete another account's conversation", async () => {
      const owner = freshGuestId();
      await store.getOrCreateUser(owner);
      await store.linkAuthUser(owner, `auth-${crypto.randomUUID()}`); // owner is an account
      const conv = await store.createConversation(owner, "owner's account thread");
      const attacker = freshGuestId();
      await store.getOrCreateUser(attacker);
      await store.linkAuthUser(attacker, `auth-${crypto.randomUUID()}`); // a DIFFERENT account

      expect(await svc().deleteConversation(conv.id, attacker)).toEqual({ ok: false, reason: "not_found" });
      expect(await store.getConversationOwner(conv.id)).not.toBeNull();
    });

    it("deletes the caller's OWN conversation (and its messages)", async () => {
      const owner = freshGuestId();
      await store.getOrCreateUser(owner);
      const conv = await store.createConversation(owner, "owner's thread");
      await store.appendMessage(conv.id, "user", "q", null);

      expect(await svc().deleteConversation(conv.id, owner)).toEqual({ ok: true });
      expect(await store.getConversation(conv.id)).toBeNull();
    });

    it("returns not_found for an unknown/malformed id (never a DB error)", async () => {
      const g = freshGuestId();
      expect(await svc().deleteConversation(crypto.randomUUID(), g)).toEqual({ ok: false, reason: "not_found" });
      expect(await svc().deleteConversation("not-a-uuid", g)).toEqual({ ok: false, reason: "not_found" });
    });
  });

  // renameConversation is ownership-gated exactly like deleteConversation, plus a bounded title (non-owner
  // reads as not_found; empty/over-long title is invalid_input). The owner's rename persists the TRIMMED title.
  describe("renameConversation ownership + title bound (039)", () => {
    function svc() {
      return createSessionService({
        store,
        guards: { guestCap: 10, dailyBudget: HUGE },
        mintToken: okMintToken(),
        now: () => new Date(),
      });
    }

    it("Should_RefuseRename_When_NotOwner: a cross-caller cannot rename another's conversation", async () => {
      const owner = freshGuestId();
      const attacker = freshGuestId();
      await store.getOrCreateUser(owner);
      await store.getOrCreateUser(attacker);
      const conv = await store.createConversation(owner, "owner's thread");

      expect(await svc().renameConversation(conv.id, "hijacked", attacker)).toEqual({ ok: false, reason: "not_found" });
      expect((await store.getConversation(conv.id))?.conversation.title).toBe("owner's thread"); // unchanged
    });

    it("renames the caller's OWN conversation, persisting the trimmed title", async () => {
      const owner = freshGuestId();
      await store.getOrCreateUser(owner);
      const conv = await store.createConversation(owner, "before");

      expect(await svc().renameConversation(conv.id, "  After the rename  ", owner)).toEqual({ ok: true, title: "After the rename" });
      expect((await store.getConversation(conv.id))?.conversation.title).toBe("After the rename"); // trimmed value stored
    });

    it("refuses an empty/whitespace or over-long (>120) title with invalid_input (title never changes)", async () => {
      const owner = freshGuestId();
      await store.getOrCreateUser(owner);
      const conv = await store.createConversation(owner, "keep me");

      expect(await svc().renameConversation(conv.id, "   ", owner)).toEqual({ ok: false, reason: "invalid_input" });
      expect(await svc().renameConversation(conv.id, "x".repeat(121), owner)).toEqual({ ok: false, reason: "invalid_input" });
      expect((await store.getConversation(conv.id))?.conversation.title).toBe("keep me");
    });

    it("returns not_found for an unknown/malformed id", async () => {
      const g = freshGuestId();
      expect(await svc().renameConversation(crypto.randomUUID(), "x", g)).toEqual({ ok: false, reason: "not_found" });
      expect(await svc().renameConversation("not-a-uuid", "x", g)).toEqual({ ok: false, reason: "not_found" });
    });
  });

  // The sign-in reconciliation that resolves every request's chat identity (adoption). Runs against the
  // real store: the three branches the epic pins - stamp (first sign-in), no-op (returning same device),
  // adopt (returning new device).
  describe("resolveIdentity", () => {
    it("returns a guest identity from the cookie when there is no auth session", async () => {
      const g = freshGuestId();
      await store.getOrCreateUser(g);
      expect(await resolveIdentity(store, { guestId: g })).toEqual({ userId: g, kind: "guest" });
    });

    it("stamps the guest's row on first sign-in - conversations follow for free (AC-11)", async () => {
      const g = freshGuestId();
      await store.getOrCreateUser(g);
      const conv = await store.createConversation(g, "guest thread");
      const authId = `auth-${crypto.randomUUID()}`;

      expect(await resolveIdentity(store, { authUserId: authId, guestId: g })).toEqual({ userId: g, kind: "account" });
      // The guest row IS the account row now; its conversation is unmoved but reads as signed-in-owned.
      expect((await store.findUserByAuthId(authId))?.user_id).toBe(g);
      expect(await store.getConversationOwner(conv.id)).toEqual({ user_id: g, auth_user_id: authId });
    });

    it("is idempotent on a returning same-device request (no re-adopt)", async () => {
      const g = freshGuestId();
      await store.getOrCreateUser(g);
      const authId = `auth-${crypto.randomUUID()}`;
      await resolveIdentity(store, { authUserId: authId, guestId: g }); // first sign-in stamps
      expect(await resolveIdentity(store, { authUserId: authId, guestId: g })).toEqual({ userId: g, kind: "account" });
    });

    it("adopts a new device's guest conversations onto the returning account (AC-11)", async () => {
      const canonical = freshGuestId(); // the account, signed in earlier on another device
      await store.getOrCreateUser(canonical);
      const authId = `auth-${crypto.randomUUID()}`;
      await store.linkAuthUser(canonical, authId);
      const g = freshGuestId(); // this device's fresh guest, with its own conversation
      await store.getOrCreateUser(g);
      const conv = await store.createConversation(g, "new device thread");

      expect(await resolveIdentity(store, { authUserId: authId, guestId: g })).toEqual({
        userId: canonical,
        kind: "account",
      });
      expect((await store.getConversationOwner(conv.id))?.user_id).toBe(canonical); // adopted
    });

    // Adversarial order: the SAME account is reached from two different guest cookies in sequence
    // (device B, then device C) - proves adoption chains cleanly rather than the second call
    // clobbering or skipping the first device's already-adopted conversation.
    it("adopts two different guests' conversations into the same account, one after another", async () => {
      const canonical = freshGuestId(); // the account, already signed in once before
      await store.getOrCreateUser(canonical);
      const authId = `auth-${crypto.randomUUID()}`;
      await store.linkAuthUser(canonical, authId);

      const deviceB = freshGuestId();
      await store.getOrCreateUser(deviceB);
      const convB = await store.createConversation(deviceB, "device B thread");

      const deviceC = freshGuestId();
      await store.getOrCreateUser(deviceC);
      const convC = await store.createConversation(deviceC, "device C thread");

      expect(await resolveIdentity(store, { authUserId: authId, guestId: deviceB })).toEqual({
        userId: canonical,
        kind: "account",
      });
      expect((await store.getConversationOwner(convB.id))?.user_id).toBe(canonical);

      // Device C signs in next. Device B's already-adopted conversation must stay put, not revert.
      expect(await resolveIdentity(store, { authUserId: authId, guestId: deviceC })).toEqual({
        userId: canonical,
        kind: "account",
      });
      expect((await store.getConversationOwner(convC.id))?.user_id).toBe(canonical);
      expect((await store.getConversationOwner(convB.id))?.user_id).toBe(canonical); // still adopted

      // Re-running either adoption is still a no-op (idempotent chaining, not just single-shot).
      await store.adoptGuest(canonical, deviceB);
      await store.adoptGuest(canonical, deviceC);
      expect((await store.getConversationOwner(convB.id))?.user_id).toBe(canonical);
      expect((await store.getConversationOwner(convC.id))?.user_id).toBe(canonical);
    });

    // Security: a signed-in caller whose forged/stale guest cookie points at ANOTHER
    // account's row must never bind onto or adopt from it. The store guards refuse (0 rows), so
    // resolveIdentity falls back to a fresh canonical row for this auth id - the victim's row and
    // conversations are untouched. (adoption is additionally bound to the sign-in transition; this is
    // the defense-in-depth layer beneath it.)
    it("refuses a forged guest cookie pointing at another account - mints a fresh row, victim untouched", async () => {
      const victim = freshGuestId();
      const victimAuth = `auth-${crypto.randomUUID()}`;
      await store.getOrCreateUser(victim);
      await store.linkAuthUser(victim, victimAuth); // the victim is a signed-in account
      const victimConv = await store.createConversation(victim, "victim's thread");

      // Attacker: a real auth session (attackerAuth) + a cookie forged to the victim's user_id.
      const attackerAuth = `auth-${crypto.randomUUID()}`;
      const res = await resolveIdentity(store, { authUserId: attackerAuth, guestId: victim });
      guests.push(res.userId); // the fresh minted row - clean it up

      expect(res.kind).toBe("account");
      expect(res.userId).not.toBe(victim); // never bound onto the victim's row
      expect((await store.findUserByAuthId(attackerAuth))?.user_id).toBe(res.userId); // its own row
      expect((await store.findUserByAuthId(victimAuth))?.user_id).toBe(victim); // binding intact
      expect((await store.getConversationOwner(victimConv.id))?.user_id).toBe(victim); // not stolen
    });

    // The auth_user_id UNIQUE race, deterministic: the losing request read
    // findUserByAuthId -> null, then its linkAuthUser lost to the winner's concurrent stamp. resolveIdentity
    // must re-read and return the winner's canonical identity (typed, no 500) and adopt the loser's device
    // conversations onto it. Simulated by pre-inserting the winner + a one-shot findUserByAuthId that
    // returns null on the loser's first read (its pre-commit snapshot) - not real concurrency.
    it("is idempotent under the first-sign-in auth_user_id race (re-reads the winner, no throw)", async () => {
      const winner = freshGuestId();
      await store.getOrCreateUser(winner);
      const authId = `auth-${crypto.randomUUID()}`;
      await store.linkAuthUser(winner, authId); // the concurrent winner already committed

      const loser = freshGuestId(); // the losing request's own device/guest cookie
      await store.getOrCreateUser(loser);
      const loserConv = await store.createConversation(loser, "loser device thread");

      // Force the loser's first findUserByAuthId to see no row yet (its pre-commit snapshot), then
      // delegate to the real store (so the post-collision re-read finds the winner).
      let firstRead = true;
      const racingStore: Store = {
        ...store,
        findUserByAuthId: async (id) => {
          if (firstRead && id === authId) {
            firstRead = false;
            return null;
          }
          return store.findUserByAuthId(id);
        },
      };

      const res = await resolveIdentity(racingStore, { authUserId: authId, guestId: loser });
      expect(res).toEqual({ userId: winner, kind: "account" }); // canonical winner, typed - no 500
      // The loser device's conversation is adopted onto the winner (as the returning-account branch does).
      expect((await store.getConversationOwner(loserConv.id))?.user_id).toBe(winner);
    });
  });
});
