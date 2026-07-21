import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import type { EmitPart } from "../../trigger/tools";
import { buildInsight, type ModelMessage } from "../../trigger/parts";
import { persistAssistantTurn } from "../../trigger/persistence";
import { createChatRun } from "../../trigger/run";

// 004 round 4 root-cause guard. In production every turn re-answered ALL prior questions: the model
// input the SDK reconstructs across a continuation boot carried the prior USER messages but NOT their
// ASSISTANT answers, so the model saw a pile of unanswered questions and answered them all again.
//
// The fix rebuilds the model input from the store (Postgres holds the full, correct history - the
// source of truth) inside the durable run, so turn N sees the full alternating user+assistant history
// with ONLY the newest user message as the new turn. This test drives turn 3 through a MOCKED model
// seam that (a) captures the exact `messages` array the model receives and (b) emits one card per
// UNANSWERED user turn - exactly how the real model behaves. It feeds `run()` the buggy SDK
// reconstruction (users only, no assistants); the fix must still hand the model the full history, so
// only the newest question is unanswered and exactly one answer is emitted. No live Bedrock.
const hasCreds = Boolean(process.env.DATABASE_URL);
const HUGE = Number.MAX_SAFE_INTEGER;
const now = () => new Date();

describe.skipIf(!hasCreds)("agent history reconstruction against real Postgres", () => {
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

  // Seed a completed 2-turn conversation: q1 -> a1, q2 -> a2 (both assistant turns persisted).
  async function seedTwoTurns(userId: string) {
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "q1");
    await store.appendMessage(conv.id, "user", "q1", null);
    await store.appendMessage(conv.id, "assistant", "a1", null);
    await store.appendMessage(conv.id, "user", "q2", null);
    await store.appendMessage(conv.id, "assistant", "a2", null);
    return conv;
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

  it("hands the model the full alternating history with only the newest user turn (turn 3)", async () => {
    const userId = freshGuestId();
    const conv = await seedTwoTurns(userId);

    const emitted: EmitPart[] = [];
    const emit = (p: EmitPart) => emitted.push(p);
    const captured: ModelMessage[][] = [];

    const run = createChatRun({
      withStore: (fn) => fn(store),
      guards: { guestCap: HUGE, dailyBudget: HUGE },
      emit,
      now,
      system: "SYS",
      // The mocked model seam: capture the exact messages, and answer every UNANSWERED user turn
      // (a user message not immediately followed by an assistant), mirroring the real model.
      streamModel: ({ messages }) => {
        captured.push(messages);
        for (let i = 0; i < messages.length; i++) {
          const next = messages[i + 1];
          if (messages[i].role === "user" && (!next || next.role !== "assistant")) {
            emit({ type: "data-insight", id: `ans-${i}`, data: { ok: true } });
          }
        }
        return "streamed" as const;
      },
    });

    // The SDK reconstruction for turn 3 as seen in production: prior USER messages present, their
    // ASSISTANT answers MISSING, the newest turn appended. This is exactly what re-answered everything.
    const result = await run({
      chatId: conv.id,
      trigger: "submit-message",
      messages: [
        { role: "user", content: "q1" },
        { role: "user", content: "q2" },
        { role: "user", content: "q3" },
      ],
      tools: {},
      signal: new AbortController().signal,
    });

    // The model seam ran (not refused) and was handed the FULL alternating history from the store.
    expect(result).toBe("streamed");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
    ]);

    // Exactly one trailing new user message.
    expect(captured[0][captured[0].length - 1]).toEqual({ role: "user", content: "q3" });
    expect(captured[0].filter((m) => m.role === "user")).toHaveLength(3);

    // Exactly one answer emitted - the newest question, not a re-answer of all three.
    const answerIds = new Set(
      emitted.filter((p) => p.type === "data-insight").map((p) => (p as { id: string }).id),
    );
    expect(answerIds.size).toBe(1);

    // The new user turn was persisted (the run is the single persist site for a follow-up).
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
  });

  // 05-testing audit gap fill (018 strand 2): the turn-3 test above proves role-alternation rebuild with
  // SYNTHETIC assistant content ("a1"/"a2"); it never exercises a REAL card turn's persisted content. The
  // Completion Report's deviation (1) states strand 2 persists the honest VERDICT (not empty content)
  // specifically so history stays role-alternating for Bedrock - this drives that claim end to end: seed
  // turn 1 as a genuine data-insight card via persistAssistantTurn (the exact site strand 2 changed), then
  // rebuild for turn 2 and assert the assistant slot is the verdict (non-empty), never dropped.
  it("rebuilds a card turn's persisted VERDICT as the assistant slot, preserving alternation for turn 2", async () => {
    const userId = freshGuestId();
    await store.getOrCreateUser(userId);
    const conv = await store.createConversation(userId, "Who is hiring the most?");
    await store.appendMessage(conv.id, "user", "Who is hiring the most?", null);

    const card = buildInsight({
      id: "m1",
      tool: "top_companies",
      params: {},
      result: {
        sql: "SELECT company, count() FROM postings FINAL GROUP BY company",
        rows: [{ company: "Google", count: 4 }],
        meta: { sampleN: 10, freshestAt: "2026-07-18 06:00:00" },
      },
    });
    // The exact strand-2 persist site: a turn with fabricated-sounding prose alongside a card persists
    // the CODE-derived verdict, never the prose.
    const responseMessage = {
      role: "assistant",
      parts: [
        { type: "text", text: "Apple and Meta are also ramping up hiring." },
        { type: "data-insight", id: "m1", data: card },
      ],
    };
    await persistAssistantTurn(store, { conversationId: conv.id, responseMessage });

    const captured: ModelMessage[][] = [];
    const run = createChatRun({
      withStore: (fn) => fn(store),
      guards: { guestCap: HUGE, dailyBudget: HUGE },
      emit: () => {},
      now,
      system: "SYS",
      streamModel: ({ messages }) => {
        captured.push(messages);
        return "streamed" as const;
      },
    });

    await run({
      chatId: conv.id,
      trigger: "submit-message",
      messages: [
        { role: "user", content: "Who is hiring the most?" },
        { role: "user", content: "How much in SF?" },
      ],
      tools: {},
      signal: new AbortController().signal,
    });

    expect(captured).toHaveLength(1);
    // Alternating user/assistant/user - the card turn's slot is non-empty (the verdict), so it was NOT
    // filtered out by buildModelHistory's empty-content drop, which would otherwise collapse this into
    // two consecutive user messages and break Bedrock's strict role-alternation requirement.
    expect(captured[0]).toEqual([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: card.verdict },
      { role: "user", content: "How much in SF?" },
    ]);
    expect(captured[0][1].content).not.toContain("Apple"); // the fabricated prose never reaches the model
  });

  it("refuses at the cap backstop BEFORE persisting the incoming turn (guards-first, D6)", async () => {
    const userId = freshGuestId();
    const conv = await seedTwoTurns(userId);

    const emitted: EmitPart[] = [];
    let modelCalled = false;

    const run = createChatRun({
      withStore: (fn) => fn(store),
      // Cap = 2: the guard runs FIRST and counts the PRIOR rows only (the 2 seeded user turns), matching
      // the action gate exactly (never one message stricter). So the over-cap follow-up is refused before
      // it ever persists.
      guards: { guestCap: 2, dailyBudget: HUGE },
      emit: (p) => emitted.push(p),
      now,
      system: "SYS",
      streamModel: () => {
        modelCalled = true;
        return "streamed" as const;
      },
    });

    const result = await run({
      chatId: conv.id,
      trigger: "submit-message",
      messages: [
        { role: "user", content: "q1" },
        { role: "user", content: "q2" },
        { role: "user", content: "q3" },
      ],
      tools: {},
      signal: new AbortController().signal,
    });

    expect(result).toBeUndefined();
    expect(modelCalled).toBe(false);
    const refusals = emitted.filter((p) => p.type === "data-refusal");
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as { data: { reason: string } }).data.reason).toBe("guest_cap");

    // D6: a refused turn persists NOTHING - not even its own user row. q3 never entered the thread.
    const reloaded = await store.getConversation(conv.id);
    expect(reloaded!.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["q1", "q2"]);
  });
});
