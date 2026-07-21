import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";

// Integration: real managed Postgres. Skipped when DATABASE_URL is absent (CI without secrets).
const hasCreds = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasCreds)("store against real Postgres", () => {
  let sql: Sql;
  let store: Store;
  const guestId = `test-guest-${crypto.randomUUID()}`;

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

  afterAll(async () => {
    await purge(guestId);
    await sql.end();
  });

  it("getOrCreateUser is idempotent - one row for the same guest id (AC-12)", async () => {
    const a = await store.getOrCreateUser(guestId);
    expect(a.user_id).toBe(guestId);
    const b = await store.getOrCreateUser(guestId);
    expect(b.created_at.getTime()).toBe(a.created_at.getTime()); // same row, not recreated
    const rows =
      await sql`SELECT count(*)::int AS c FROM users WHERE user_id = ${guestId}`;
    expect(rows[0].c).toBe(1);
  });

  it("createConversation derives a never-null title and persists it", async () => {
    await store.getOrCreateUser(guestId);
    const conv = await store.createConversation(
      guestId,
      "  What is the median salary in SF?  ",
    );
    expect(conv.title).toBe("What is the median salary in SF?");
    expect(conv.id).toBeTruthy();
    const reload = await store.getConversation(conv.id);
    expect(reload?.conversation.title).toBe("What is the median salary in SF?");
  });

  it("appendMessage stores null parts for user turns and JSON parts for assistant turns", async () => {
    await store.getOrCreateUser(guestId);
    const conv = await store.createConversation(
      guestId,
      "Top companies hiring?",
    );
    const userMsg = await store.appendMessage(
      conv.id,
      "user",
      "Top companies hiring?",
      null,
    );
    expect(userMsg.parts).toBeNull();
    expect(userMsg.role).toBe("user");

    const parts = { id: "p1", kind: "chart", verdict: "Google leads" };
    const asstMsg = await store.appendMessage(
      conv.id,
      "assistant",
      "Google is hiring most.",
      parts,
    );
    expect(asstMsg.parts).toEqual(parts);

    const loaded = await store.getConversation(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(loaded!.messages[1].parts).toEqual(parts);
  });

  // AC-5: a caller-supplied message id makes the write idempotent - re-persisting the SAME id (a
  // replayed or re-executed completion reaching persistence twice) inserts exactly once. ON CONFLICT
  // (id) DO NOTHING, first write wins.
  it("appendMessage inserts once when the same message id is persisted twice (AC-5)", async () => {
    await store.getOrCreateUser(guestId);
    const conv = await store.createConversation(guestId, "idempotent persist?");
    const id = crypto.randomUUID();
    await store.appendMessage(conv.id, "assistant", "first write", { id: "p", kind: "table" }, id);
    // A redelivered / replayed completion re-persists the same id: it must not add a second row.
    await store.appendMessage(conv.id, "assistant", "second write", { id: "p", kind: "table" }, id);

    const count =
      await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM messages WHERE id = ${id}`;
    expect(count[0].c).toBe(1);
    // DO NOTHING keeps the original row: the first write wins, the second is dropped silently.
    const loaded = await store.getConversation(conv.id);
    expect(loaded!.messages.find((m) => m.id === id)?.content).toBe("first write");
  });

  // Contract boundary of the AC-5 upsert: omitting `id` must behave exactly as before the id column
  // was added - the DB mints a fresh uuid per call, so two calls (even with identical role/content, as
  // the count-keyed user-turn path can produce) insert TWO distinct rows, never deduped. This guards
  // the no-id caller path (persistIncomingUserTurns' user rows) against a regression from the new
  // id-supplied ON CONFLICT branch.
  it("appendMessage with no id mints a distinct row every call - repeats are not deduped", async () => {
    await store.getOrCreateUser(guestId);
    const conv = await store.createConversation(guestId, "no-id append twice?");
    const a = await store.appendMessage(conv.id, "user", "same text", null);
    const b = await store.appendMessage(conv.id, "user", "same text", null);

    expect(a.id).not.toBe(b.id); // distinct DB-minted ids, not the same row
    const count =
      await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM messages WHERE conversation_id = ${conv.id}`;
    expect(count[0].c).toBe(2); // two rows, not one deduped row
    const loaded = await store.getConversation(conv.id);
    expect(loaded!.messages.map((m) => m.content)).toEqual(["same text", "same text"]);
  });

  it("getConversation returns null for a missing id", async () => {
    expect(await store.getConversation(crypto.randomUUID())).toBeNull();
  });

  // The module contract says "`null` always means not found". A malformed (non-UUID) id must honor
  // that from the caller's view - not surface Postgres' `invalid input syntax for type uuid` as an
  // unhandled error. 006 wires `/chat/[id]` from an untrusted URL param, so a garbage id must land
  // on the null/404 path, not a 500.
  it("getConversation returns null for a malformed (non-UUID) id, not a DB error", async () => {
    expect(await store.getConversation("not-a-valid-uuid")).toBeNull();
    expect(await store.getConversation("")).toBeNull();
    expect(await store.getConversation("123")).toBeNull();
  });

  // The lightweight owner lookup backing authorization + the agent guard: one row (conversations JOIN
  // users), no history. Widened (012) to carry the owner's auth_user_id so the run() backstop can pick
  // the cap by identity kind (null = guest cap, set = signed-in cap).
  it("getConversationOwner returns { user_id, auth_user_id }, or null for missing/malformed ids", async () => {
    await store.getOrCreateUser(guestId);
    const conv = await store.createConversation(guestId, "Who owns this?");
    expect(await store.getConversationOwner(conv.id)).toEqual({
      user_id: guestId,
      auth_user_id: null,
    });
    expect(await store.getConversationOwner(crypto.randomUUID())).toBeNull(); // unknown
    expect(await store.getConversationOwner("not-a-uuid")).toBeNull(); // malformed, not a DB error
  });

  // findUserByAuthId is the account lookup on every signed-in request (backed by the auth_user_id
  // UNIQUE btree index); null when no users row is linked to that Better Auth id yet.
  it("findUserByAuthId returns the linked users row, or null when unmapped (012)", async () => {
    const authId = `auth-${crypto.randomUUID()}`;
    const u = `test-guest-${crypto.randomUUID()}`;
    expect(await store.findUserByAuthId(authId)).toBeNull();
    await store.getOrCreateUser(u);
    await store.linkAuthUser(u, authId);
    const found = await store.findUserByAuthId(authId);
    expect(found?.user_id).toBe(u);
    expect(found?.auth_user_id).toBe(authId);
    await purge(u);
  });

  // linkAuthUser stamps the guest's row on first sign-in (conversations follow for free), so the
  // widened owner lookup then reports the account identity.
  it("linkAuthUser stamps auth_user_id on the users row (012)", async () => {
    const authId = `auth-${crypto.randomUUID()}`;
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    const conv = await store.createConversation(u, "mine");
    await store.linkAuthUser(u, authId);
    expect(await store.getConversationOwner(conv.id)).toEqual({
      user_id: u,
      auth_user_id: authId,
    });
    await purge(u);
  });

  // 012 review-fix (security): the stamp primitive must NEVER overwrite a row already linked to a
  // DIFFERENT account - a forged/stale guest cookie pointing at a signed-in row must not take it over.
  // The guard is the SQL itself (WHERE auth_user_id IS NULL), so no caller can misuse it.
  it("linkAuthUser refuses to rebind a row already linked to a DIFFERENT account (guard, no takeover)", async () => {
    const victim = `test-guest-${crypto.randomUUID()}`;
    const victimAuth = `auth-${crypto.randomUUID()}`;
    await store.getOrCreateUser(victim);
    expect(await store.linkAuthUser(victim, victimAuth)).toBe(true); // legit first stamp
    // An attacker's auth id must NOT overwrite the victim's binding: 0 rows matched, refused (no throw).
    const attackerAuth = `auth-${crypto.randomUUID()}`;
    expect(await store.linkAuthUser(victim, attackerAuth)).toBe(false);
    expect((await store.findUserByAuthId(victimAuth))?.user_id).toBe(victim); // still the victim's
    expect(await store.findUserByAuthId(attackerAuth)).toBeNull(); // never bound
    await purge(victim);
  });

  // 012 review-fix (the auth_user_id UNIQUE race, deterministic): two concurrent first sign-ins of the
  // SAME account both read findUserByAuthId -> null, then both stamp their own guest row; the loser's
  // UPDATE passes the `auth_user_id IS NULL` guard on its OWN row but collides with the winner's
  // auth_user_id UNIQUE. The store catches that and reports "did not stamp" (typed false), never a 500 -
  // the caller re-reads for the canonical winner. Simulated by pre-inserting the winner, not concurrency.
  it("linkAuthUser returns false (typed, no throw) when the auth id is already taken - the UNIQUE race", async () => {
    const winner = `test-guest-${crypto.randomUUID()}`;
    const loser = `test-guest-${crypto.randomUUID()}`;
    const authId = `auth-${crypto.randomUUID()}`;
    await store.getOrCreateUser(winner);
    await store.getOrCreateUser(loser);
    expect(await store.linkAuthUser(winner, authId)).toBe(true); // winner stamped first
    // The loser's row is unstamped (passes the IS NULL guard) but the SET collides with the UNIQUE
    // constraint -> caught and reported as false, not surfaced as an untyped throw.
    expect(await store.linkAuthUser(loser, authId)).toBe(false);
    expect((await store.findUserByAuthId(authId))?.user_id).toBe(winner); // winner unchanged
    expect((await store.getOrCreateUser(loser)).auth_user_id).toBeNull(); // loser never bound
    await purge(winner);
    await purge(loser);
  });

  // 012 review-fix (security): adoption must move conversations only FROM a genuine guest row
  // (auth_user_id IS NULL). A row that already belongs to a DIFFERENT account is off-limits - a forged
  // guest cookie must not steal a signed-in user's conversations. Guard is the SQL (EXISTS ... IS NULL).
  it("adoptGuest does not move conversations from a source row linked to a DIFFERENT account (guard, no theft)", async () => {
    const victim = `test-guest-${crypto.randomUUID()}`;
    const victimAuth = `auth-${crypto.randomUUID()}`;
    await store.getOrCreateUser(victim);
    await store.linkAuthUser(victim, victimAuth); // victim is a signed-in account
    const vConv = await store.createConversation(victim, "victim's thread");
    const attacker = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(attacker);

    await store.adoptGuest(attacker, victim); // attacker tries to adopt FROM the account row
    expect((await store.getConversationOwner(vConv.id))?.user_id).toBe(victim); // unmoved
    await purge(victim);
    await purge(attacker);
  });

  // AC-11 (store slice): sign-in on a device holding guest conversations adopts them onto the account's
  // canonical row - a single UPDATE of conversations.user_id, no message copying. Idempotent (re-run =
  // no-op, since no conversation is left under the guest id).
  it("adoptGuest re-points the guest's conversations to the canonical row; idempotent (AC-11)", async () => {
    const canonical = `test-guest-${crypto.randomUUID()}`;
    const guest = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(canonical);
    await store.getOrCreateUser(guest);
    const c1 = await store.createConversation(guest, "guest q1");
    const c2 = await store.createConversation(guest, "guest q2");
    await store.appendMessage(c1.id, "user", "guest q1", null); // messages stay put (no copying)

    await store.adoptGuest(canonical, guest);
    expect((await store.getConversationOwner(c1.id))?.user_id).toBe(canonical);
    expect((await store.getConversationOwner(c2.id))?.user_id).toBe(canonical);
    // The messages still hang off c1 (conversation moved, not the messages).
    expect((await store.getConversation(c1.id))?.messages).toHaveLength(1);

    // Idempotent: a second run moves nothing and leaves the canonical ownership intact.
    await store.adoptGuest(canonical, guest);
    expect((await store.getConversationOwner(c1.id))?.user_id).toBe(canonical);

    await purge(canonical);
    await purge(guest);
  });

  // Adversarial order: a guest signs in having never started a chat (zero conversations). The UPDATE
  // matches zero rows - a safe no-op, not an error - and leaves the canonical row's own conversations
  // (if any) untouched.
  it("adoptGuest is a no-op for a guest with zero conversations", async () => {
    const canonical = `test-guest-${crypto.randomUUID()}`;
    const guest = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(canonical);
    await store.getOrCreateUser(guest); // guest row exists, but starts no conversation
    const priorConv = await store.createConversation(
      canonical,
      "canonical's own thread",
    );

    await expect(store.adoptGuest(canonical, guest)).resolves.toBeUndefined();
    // The canonical's pre-existing conversation is unaffected by an empty adoption.
    expect((await store.getConversationOwner(priorConv.id))?.user_id).toBe(
      canonical,
    );

    await purge(canonical);
    await purge(guest);
  });

  // AC-12 (store slice): the sidebar history is newest-first. created_at is pinned to distinct values so
  // the ordering assertion is deterministic (not a clock-race between same-millisecond inserts).
  it("listConversations returns the user's conversations newest-first (AC-12)", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    const a = await store.createConversation(u, "oldest");
    const b = await store.createConversation(u, "middle");
    const c = await store.createConversation(u, "newest");
    await sql`UPDATE conversations SET created_at = ${new Date("2026-07-01T00:00:00Z")} WHERE id = ${a.id}`;
    await sql`UPDATE conversations SET created_at = ${new Date("2026-07-02T00:00:00Z")} WHERE id = ${b.id}`;
    await sql`UPDATE conversations SET created_at = ${new Date("2026-07-03T00:00:00Z")} WHERE id = ${c.id}`;

    const list = await store.listConversations(u);
    expect(list.map((x) => x.title)).toEqual(["newest", "middle", "oldest"]);
    expect(list.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    await purge(u);
  });

  // refresh #2 s5: each history row carries the conversation's FIRST user message as a preview, so rows
  // that share a title stay distinguishable. An assistant turn never becomes the preview.
  it("listConversations returns the first user message as each row's preview (refresh #2 s5)", async () => {
    const u = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(u);
    const conv = await store.createConversation(u, "Median salary in SF");
    await store.appendMessage(
      conv.id,
      "user",
      "what is the median salary for a data engineer in SF",
      null,
    );
    await store.appendMessage(conv.id, "assistant", "The median is $182k.", {
      kind: "system",
    });
    await store.appendMessage(
      conv.id,
      "user",
      "a later follow-up that must NOT win",
      null,
    );

    const empty = await store.createConversation(u, "No messages yet");

    const list = await store.listConversations(u);
    const byId = new Map(list.map((x) => [x.id, x.preview]));
    expect(byId.get(conv.id)).toBe(
      "what is the median salary for a data engineer in SF",
    ); // first user turn only
    expect(byId.get(empty.id)).toBe(""); // COALESCE guard: a conversation with no user turn

    await purge(u);
  });

  // AC-21: deleting a conversation removes it AND its messages (the FK has no ON DELETE CASCADE, so the
  // store deletes both in one transaction). A sibling conversation's messages are untouched.
  it("deleteConversation removes the conversation and its messages, leaving siblings intact (AC-21)", async () => {
    const owner = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(owner);
    const target = await store.createConversation(owner, "delete me");
    await store.appendMessage(target.id, "user", "q1", null);
    await store.appendMessage(target.id, "assistant", "a1", {
      id: "p",
      kind: "table",
    });
    const keep = await store.createConversation(owner, "keep me");
    await store.appendMessage(keep.id, "user", "q2", null);

    await store.deleteConversation(target.id);

    expect(await store.getConversation(target.id)).toBeNull(); // conversation gone
    const orphaned =
      await sql`SELECT count(*)::int AS c FROM messages WHERE conversation_id = ${target.id}`;
    expect(orphaned[0].c).toBe(0); // its messages cascaded (no FK-violation, no orphans)
    // The sibling and its message survive.
    expect((await store.getConversation(keep.id))?.messages).toHaveLength(1);

    // Idempotent / malformed-id safety: deleting again and a garbage id are both no-ops, not errors.
    await expect(store.deleteConversation(target.id)).resolves.toBeUndefined();
    await expect(
      store.deleteConversation("not-a-uuid"),
    ).resolves.toBeUndefined();

    await purge(owner);
  });

  // R3 must-fix (022): a regenerate supersedes the row it re-answers. deleteTrailingAssistant is the
  // narrow durable mirror of the SDK's trailing-assistant pop - it removes ONLY the assistant row(s)
  // trailing the LAST user message, leaving earlier turns intact. Validates the (created_at, id) tuple
  // comparison against real Postgres (the same composite order getConversation reads by).
  it("deleteTrailingAssistant pops the assistant row(s) after the last user turn, leaving prior turns intact", async () => {
    const owner = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(owner);
    const conv = await store.createConversation(owner, "regenerate me");
    await store.appendMessage(conv.id, "user", "q1", null);
    await store.appendMessage(conv.id, "assistant", "a1", { id: "p1", kind: "table" });
    await store.appendMessage(conv.id, "user", "q2 - the turn being retried", null);
    // The failed turn's error-card row, trailing the last user turn (content "" - errors persist verbatim).
    await store.appendMessage(conv.id, "assistant", "", { kind: "system" });

    await store.deleteTrailingAssistant(conv.id);

    const loaded = await store.getConversation(conv.id);
    // Only the trailing error card is gone; q1/a1/q2 survive - the tail is now the user turn to re-answer.
    expect(loaded!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(loaded!.messages.map((m) => m.content)).toEqual(["q1", "a1", "q2 - the turn being retried"]);

    await purge(owner);
  });

  // No-op contracts: nothing trails the last user (a normal submit state), and a malformed id.
  it("deleteTrailingAssistant is a no-op when the tail is already a user turn, or the id is malformed", async () => {
    const owner = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(owner);
    const conv = await store.createConversation(owner, "nothing to pop");
    await store.appendMessage(conv.id, "user", "q1", null);
    await store.appendMessage(conv.id, "assistant", "a1", { id: "p1", kind: "table" });
    await store.appendMessage(conv.id, "user", "q2", null); // the just-persisted user turn, no answer yet

    await store.deleteTrailingAssistant(conv.id);
    expect((await store.getConversation(conv.id))!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]); // unchanged - nothing trails the last user

    await expect(store.deleteTrailingAssistant("not-a-uuid")).resolves.toBeUndefined(); // malformed = no-op

    await purge(owner);
  });

  it("messageCounts scopes to a user (cap) and aggregates globally (daily budget)", async () => {
    const freshGuest = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(freshGuest);
    const conv = await store.createConversation(freshGuest, "Q");
    await store.appendMessage(conv.id, "user", "one", null);
    await store.appendMessage(conv.id, "assistant", "answer", {
      id: "p",
      kind: "table",
    });
    await store.appendMessage(conv.id, "user", "two", null);

    const since = new Date(0);
    const scoped = await store.messageCounts({
      userId: freshGuest,
      sinceUtcMidnight: since,
    });
    expect(scoped).toBe(2); // two user turns; the assistant reply is not counted
    const global = await store.messageCounts({ sinceUtcMidnight: since });
    expect(global).toBeGreaterThanOrEqual(scoped);

    await purge(freshGuest);
  });

  // The `since=new Date(0)` case above can't distinguish "filters correctly" from "ignores the
  // filter" - every message is after the epoch either way. Backdate rows directly (the store's API
  // has no way to set created_at) to prove the boundary is inclusive (>=, per the interface doc)
  // and that an out-of-window message is genuinely excluded, not just outnumbered.
  it("messageCounts excludes a message before sinceUtcMidnight and includes one exactly at it", async () => {
    const freshGuest = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(freshGuest);
    const conv = await store.createConversation(freshGuest, "Boundary check");

    const boundary = new Date("2026-07-18T00:00:00.000Z");
    const before = new Date(boundary.getTime() - 1000); // 1s before the boundary: must be excluded

    await sql`INSERT INTO messages (conversation_id, role, content, created_at)
              VALUES (${conv.id}, 'user', 'before boundary', ${before})`;
    await sql`INSERT INTO messages (conversation_id, role, content, created_at)
              VALUES (${conv.id}, 'user', 'at boundary', ${boundary})`;

    const scoped = await store.messageCounts({
      userId: freshGuest,
      sinceUtcMidnight: boundary,
    });
    expect(scoped).toBe(1); // only the at-boundary row; the before-boundary row is excluded

    await purge(freshGuest);
  });
});
