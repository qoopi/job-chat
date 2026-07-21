import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import { buildInsight, extractAssistantPersistence, persistAssistantTurn } from "../../trigger/parts";

// AC-13: when a turn completes the agent persists the assistant message + full card payload, so a
// returning guest's conversation restores from the store without re-running queries. Integration
// against real Postgres (the agent's onTurnComplete uses this exact path). Skipped without creds.
const hasCreds = Boolean(process.env.DATABASE_URL);

function insight(id: string) {
  return buildInsight({
    id,
    tool: "top_companies",
    params: {},
    result: {
      sql: "SELECT company, count() FROM postings FINAL GROUP BY company",
      rows: [
        { company: "Google", count: 4 },
        { company: "Meta", count: 2 },
      ],
      meta: { sampleN: 10, freshestAt: "2026-07-18 06:00:00" },
    },
  });
}

describe.skipIf(!hasCreds)("assistant-turn persistence against real Postgres", () => {
  let sql: Sql;
  let store: Store;
  const guestId = `test-guest-${crypto.randomUUID()}`;

  async function purge(user: string) {
    await sql`DELETE FROM messages m USING conversations cv
              WHERE m.conversation_id = cv.id AND cv.user_id = ${user}`;
    await sql`DELETE FROM conversations WHERE user_id = ${user}`;
    await sql`DELETE FROM users WHERE user_id = ${user}`;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    store = createStore(sql);
    await store.getOrCreateUser(guestId);
  });

  afterAll(async () => {
    await purge(guestId);
    await sql.end();
  });

  it("persists the assistant content + full insight payload, restored intact on reload (AC-13)", async () => {
    const conv = await store.createConversation(guestId, "Who is hiring the most?");
    await store.appendMessage(conv.id, "user", "Who is hiring the most?", null);

    const card = insight("m1");
    const responseMessage = {
      role: "assistant",
      parts: [
        { type: "text", text: "Google is out in front." },
        { type: "data-insight", id: "m1", data: card },
      ],
    };
    await persistAssistantTurn(store, { conversationId: conv.id, responseMessage });

    const reloaded = await store.getConversation(conv.id);
    expect(reloaded).not.toBeNull();
    const assistant = reloaded!.messages.find((m) => m.role === "assistant");
    // 018 strand 2: a card turn persists the code-derived VERDICT, NOT the model's prose ("Google is out
    // in front." is dropped), so a fabricated sentence can never resume or feed the next turn's history.
    expect(assistant?.content).toBe(card.verdict);
    expect(assistant?.content).toBe("Google is hiring the most, with 4 openings.");
    // The full card payload still survives verbatim - verdict, chart series, SQL, meta.
    expect(assistant?.parts).toEqual(card);
  });

  it("persists a stopped turn's partial (cleaned) response - the cancelled-run resume path", async () => {
    const conv = await store.createConversation(guestId, "Salary in SF?");
    await store.appendMessage(conv.id, "user", "Salary in SF?", null);

    // A stopped turn: onTurnComplete still fires; responseMessage holds the partial text with aborted
    // parts cleaned up. Here that is a lead-in with no card yet.
    const responseMessage = { role: "assistant", parts: [{ type: "text", text: "Let me check that" }] };
    const { parts } = extractAssistantPersistence(responseMessage);
    expect(parts).toBeNull();

    await persistAssistantTurn(store, { conversationId: conv.id, responseMessage });
    const reloaded = await store.getConversation(conv.id);
    const assistant = reloaded!.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Let me check that");
    expect(assistant?.parts).toBeNull();
  });
});
