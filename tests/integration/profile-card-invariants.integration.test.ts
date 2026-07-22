import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import { profileCardMessageId } from "../../trigger/profile-card-id";
import type { Profile } from "@shared/profile";

// The out-of-band profile-card append is safe against the turn machinery, proven against real Postgres:
// a Retry after a save keeps the card (deleteTrailingAssistant skips it), and a double-save can never
// duplicate it (the deterministic id + appendProfileCard's DO UPDATE replace). Skipped without creds.
const hasCreds = Boolean(process.env.DATABASE_URL);

function profile(title: string): Profile {
  return {
    titles: [title],
    seniority: "senior",
    skills: [],
    locations: [],
    remotePref: null,
    salaryMin: null,
    yearsExp: null,
    domains: [],
    ossHighlights: [],
    experience: [],
  };
}

describe.skipIf(!hasCreds)("profile-card invariants against real Postgres", () => {
  let sql: Sql;
  let store: Store;
  const owner = `test-guest-${crypto.randomUUID()}`;

  async function purge(user: string) {
    await sql`DELETE FROM messages m USING conversations cv
              WHERE m.conversation_id = cv.id AND cv.user_id = ${user}`;
    await sql`DELETE FROM conversations WHERE user_id = ${user}`;
    await sql`DELETE FROM users WHERE user_id = ${user}`;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    store = createStore(sql);
    await store.getOrCreateUser(owner);
  });

  afterAll(async () => {
    await purge(owner);
    await sql.end();
  });

  // Invariant (a)+(b): a Retry after a save. The answer trailing the last user turn is popped, but the
  // out-of-band profile-card row is spared - a regenerate can never destroy the card.
  it("Should_KeepProfileCard_When_RegenerateAfterSave: deleteTrailingAssistant pops the answer but keeps the card", async () => {
    const conv = await store.createConversation(owner, "Who is hiring?");
    await store.appendMessage(conv.id, "user", "Who is hiring?", null);
    await store.appendMessage(conv.id, "assistant", "Google leads.", { id: "p1", kind: "table" });
    // The save flow appends the out-of-band card AFTER the answer.
    const cardId = profileCardMessageId(conv.id);
    await store.appendProfileCard(conv.id, cardId, { kind: "profile-card", profile: profile("Senior Backend Engineer") });

    await store.deleteTrailingAssistant(conv.id); // the regenerate pop

    const loaded = await store.getConversation(conv.id);
    const ids = loaded!.messages.map((m) => m.id);
    expect(ids).toContain(cardId); // the card SURVIVED the pop
    // Exactly the answer row was removed; the card + the user turn remain.
    expect(loaded!.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // user q1, the card
    const card = loaded!.messages.find((m) => m.id === cardId);
    expect((card!.parts as { kind: string }).kind).toBe("profile-card");
  });

  // Invariant: a double-save (or a re-save/Update) writes ONE card under the deterministic id - the
  // second write REPLACES the first (never a duplicate), and the latest profile wins.
  it("Should_ReplaceNotDuplicateCard_When_DoubleSave: same id -> one row, replaced with the latest profile", async () => {
    const conv = await store.createConversation(owner, "Profile please");
    const cardId = profileCardMessageId(conv.id);

    await store.appendProfileCard(conv.id, cardId, { kind: "profile-card", profile: profile("Backend Engineer") });
    await store.appendProfileCard(conv.id, cardId, { kind: "profile-card", profile: profile("Staff Engineer") });

    const count = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM messages WHERE id = ${cardId}`;
    expect(count[0].c).toBe(1); // never duplicated
    const loaded = await store.getConversation(conv.id);
    const card = loaded!.messages.find((m) => m.id === cardId);
    expect((card!.parts as { profile: Profile }).profile.titles).toEqual(["Staff Engineer"]); // latest wins (replaced)
  });
});
