import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";
import type { EmitPart } from "../../trigger/tools";
import type { ModelMessage } from "../../trigger/parts";
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

  it("refuses at the cap backstop without ever calling the model seam", async () => {
    const userId = freshGuestId();
    const conv = await seedTwoTurns(userId);

    const emitted: EmitPart[] = [];
    let modelCalled = false;

    const run = createChatRun({
      withStore: (fn) => fn(store),
      // Cap = 3: after the new turn persists (3 user messages) the backstop bites.
      guards: { guestCap: 3, dailyBudget: HUGE },
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
  });
});
