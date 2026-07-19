import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import { checkConversationGuards, checkMessageGuards } from "../../trigger/guard";

// The AGENT-SIDE backstop (must-fix A): the browser holds a write-scoped session token and the
// standard transport can append follow-ups straight to the session inbox, bypassing the server
// action's early cap/budget refusal. This proves the same guard - counted via the store, keyed only
// on the conversation id the durable run holds - refuses a turn past the cap/budget ON THE AGENT
// PATH. Integration against real Postgres (the guard's exact runtime path). Skipped without creds.
const hasCreds = Boolean(process.env.DATABASE_URL);
const HUGE = Number.MAX_SAFE_INTEGER;
const now = () => new Date();

describe.skipIf(!hasCreds)("agent guard backstop against real Postgres", () => {
  let sql: Sql;
  let store: Store;
  const guests: string[] = [];

  function freshGuestId(): string {
    const id = `test-guest-${crypto.randomUUID()}`;
    guests.push(id);
    return id;
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

  // The biting test: a conversation already at the cap. A direct inbox append (the transport path)
  // reaches the agent, which resolves the owner from the chatId alone and refuses - no Bedrock turn.
  it("refuses guest_cap when the conversation's owner is already at the cap (AC-15)", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "cap check");
    const cap = 10;
    for (let i = 0; i < cap; i++) await store.appendMessage(conv.id, "user", `msg ${i}`, null);

    const refusal = await checkConversationGuards(
      { store, guards: { guestCap: cap, dailyBudget: HUGE }, now },
      conv.id,
    );
    expect(refusal).toBe("guest_cap");
  });

  it("allows a turn while the owner is under the cap", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "under cap");
    await store.appendMessage(conv.id, "user", "just one", null);

    const refusal = await checkConversationGuards(
      { store, guards: { guestCap: 10, dailyBudget: HUGE }, now },
      conv.id,
    );
    expect(refusal).toBeNull();
  });

  // The spend kill switch is GLOBAL: the agent refuses even a fresh conversation once other traffic
  // alone has exhausted the daily budget (proves the backstop's budget count is not owner-scoped).
  it("refuses daily_budget for any conversation once the global budget is exhausted (AC-20)", async () => {
    const noisy = freshGuestId();
    await store.getOrCreateUser(noisy);
    const noisyConv = await store.createConversation(noisy, "seed");
    const budget = 3;
    for (let i = 0; i < budget; i++) await store.appendMessage(noisyConv.id, "user", `seed ${i}`, null);

    const fresh = freshGuestId();
    await store.getOrCreateUser(fresh);
    const freshConv = await store.createConversation(fresh, "brand new");

    const refusal = await checkConversationGuards(
      { store, guards: { guestCap: 10, dailyBudget: budget }, now },
      freshConv.id,
    );
    expect(refusal).toBe("daily_budget");
  });

  it("returns null (nothing to guard) for an unknown conversation id", async () => {
    const refusal = await checkConversationGuards(
      { store, guards: { guestCap: 10, dailyBudget: HUGE }, now },
      crypto.randomUUID(),
    );
    expect(refusal).toBeNull();
  });

  // The shared count powering both layers: budget (global) checked before cap (scoped), one round trip.
  it("checkMessageGuards prioritizes the global budget over the per-guest cap", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "priority");
    await store.appendMessage(conv.id, "user", "one", null);

    // Budget already blown AND cap blown -> budget wins (the kill switch is the stronger signal).
    expect(await checkMessageGuards({ store, guards: { guestCap: 0, dailyBudget: 0 }, now }, userId)).toBe(
      "daily_budget",
    );
  });
});
