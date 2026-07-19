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
    const rows = await sql`SELECT count(*)::int AS c FROM users WHERE user_id = ${guestId}`;
    expect(rows[0].c).toBe(1);
  });

  it("createConversation derives a never-null title and persists it", async () => {
    await store.getOrCreateUser(guestId);
    const conv = await store.createConversation(guestId, "  What is the median salary in SF?  ");
    expect(conv.title).toBe("What is the median salary in SF?");
    expect(conv.id).toBeTruthy();
    const reload = await store.getConversation(conv.id);
    expect(reload?.conversation.title).toBe("What is the median salary in SF?");
  });

  it("appendMessage stores null parts for user turns and JSON parts for assistant turns", async () => {
    await store.getOrCreateUser(guestId);
    const conv = await store.createConversation(guestId, "Top companies hiring?");
    const userMsg = await store.appendMessage(conv.id, "user", "Top companies hiring?", null);
    expect(userMsg.parts).toBeNull();
    expect(userMsg.role).toBe("user");

    const parts = { id: "p1", kind: "chart", verdict: "Google leads" };
    const asstMsg = await store.appendMessage(conv.id, "assistant", "Google is hiring most.", parts);
    expect(asstMsg.parts).toEqual(parts);

    const loaded = await store.getConversation(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(loaded!.messages[1].parts).toEqual(parts);
  });

  it("getConversation returns null for a missing id", async () => {
    expect(await store.getConversation(crypto.randomUUID())).toBeNull();
  });

  it("messageCounts scopes to a user (cap) and aggregates globally (daily budget)", async () => {
    const freshGuest = `test-guest-${crypto.randomUUID()}`;
    await store.getOrCreateUser(freshGuest);
    const conv = await store.createConversation(freshGuest, "Q");
    await store.appendMessage(conv.id, "user", "one", null);
    await store.appendMessage(conv.id, "assistant", "answer", { id: "p", kind: "table" });
    await store.appendMessage(conv.id, "user", "two", null);

    const since = new Date(0);
    const scoped = await store.messageCounts({ userId: freshGuest, sinceUtcMidnight: since });
    expect(scoped).toBe(2); // two user turns; the assistant reply is not counted
    const global = await store.messageCounts({ sinceUtcMidnight: since });
    expect(global).toBeGreaterThanOrEqual(scoped);

    await purge(freshGuest);
  });
});
