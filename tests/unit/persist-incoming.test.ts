import { describe, expect, it } from "vitest";
import type { Store, Message } from "@shared/store";
import { persistIncomingUserTurns } from "../../trigger/persistence";
import { MAX_INPUT_CHARS } from "../../trigger/guard";

// The single persist site for a follow-up user turn. Because a follow-up is
// delivered by the client transport's `sendMessages` (deliver+watch - the only SDK path that streams a
// freshly-triggered turn live) rather than by the server action, the agent's `run()` persists the user
// turn before the guard counts it. This is count-based (persist the tail of user messages beyond what the
// store already holds) so it is a no-op on turn-1 arrival and on regenerate - never double-persisting.

/** A fake store seeded with `existingMessages`, recording every appendMessage (nothing else is touched). */
function fakeStore(existingMessages: Array<{ role: "user" | "assistant"; content: string }>, opts?: { notFound?: boolean }) {
  const messages = existingMessages.map((m, i) => ({ ...m, id: `seed-${i}` }) as unknown as Message);
  const appended: Array<{ role: string; content: string; parts: unknown }> = [];
  const boom = () => {
    throw new Error("store method must not be touched");
  };
  const store = {
    getConversation: async () => (opts?.notFound ? null : { conversation: {} as never, messages: [...messages] }),
    appendMessage: async (_conversationId: string, role: "user" | "assistant", content: string, parts: unknown) => {
      appended.push({ role, content, parts });
      const row = { role, content, id: `new-${appended.length}` } as unknown as Message;
      messages.push(row);
      return row;
    },
    getOrCreateUser: boom,
    createConversation: boom,
    getConversationOwner: boom,
    messageCounts: boom,
  } as unknown as Store;
  return { store, appended };
}

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

describe("persistIncomingUserTurns (the run() single persist site)", () => {
  it("is a NO-OP on turn-1 arrival (message #1 already persisted by startConversation)", async () => {
    const { store, appended } = fakeStore([user("q1")]);
    await persistIncomingUserTurns(store, "c1", [user("q1")]);
    expect(appended).toEqual([]);
  });

  it("persists EXACTLY the new follow-up turn (not the prior, already-stored turns)", async () => {
    const { store, appended } = fakeStore([user("q1"), assistant("a1")]);
    await persistIncomingUserTurns(store, "c1", [user("q1"), assistant("a1"), user("q2")]);
    expect(appended).toEqual([{ role: "user", content: "q2", parts: null }]);
  });

  it("is a NO-OP on regenerate (no new user turn - the trailing assistant is dropped, same user turns)", async () => {
    const { store, appended } = fakeStore([user("q1"), assistant("a1"), user("q2")]);
    await persistIncomingUserTurns(store, "c1", [user("q1"), assistant("a1"), user("q2")]);
    expect(appended).toEqual([]);
  });

  it("reads the user text from an array of model-message text parts", async () => {
    const { store, appended } = fakeStore([user("q1"), assistant("a1")]);
    await persistIncomingUserTurns(store, "c1", [
      user("q1"),
      assistant("a1"),
      { role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "there" }] },
    ]);
    expect(appended).toEqual([{ role: "user", content: "hello there", parts: null }]);
  });

  it("persists the first turn when the conversation is not yet in the store", async () => {
    const { store, appended } = fakeStore([], { notFound: true });
    await persistIncomingUserTurns(store, "c1", [user("q1")]);
    expect(appended).toEqual([{ role: "user", content: "q1", parts: null }]);
  });

  it("skips a blank/whitespace user turn rather than persisting an empty row", async () => {
    const { store, appended } = fakeStore([user("q1"), assistant("a1")]);
    await persistIncomingUserTurns(store, "c1", [user("q1"), assistant("a1"), user("   ")]);
    expect(appended).toEqual([]);
  });

  // Input-size backstop on the real follow-up path (mechanism a): the client transport appends to `.in`
  // with only a write-scoped token, bypassing the action's TextSchema gate. An over-length incoming turn
  // must be refused HERE - before any persist - so the oversized payload never reaches Postgres or Bedrock.
  it("refuses an over-length incoming turn with 'too_long' and persists NOTHING", async () => {
    const { store, appended } = fakeStore([user("q1"), assistant("a1")]);
    const oversized = "x".repeat(MAX_INPUT_CHARS + 1);
    const outcome = await persistIncomingUserTurns(store, "c1", [user("q1"), assistant("a1"), user(oversized)]);
    expect(outcome).toBe("too_long");
    expect(appended).toEqual([]);
  });

  it("persists a turn exactly at the length bound (the bound is inclusive) and returns null", async () => {
    const { store, appended } = fakeStore([user("q1"), assistant("a1")]);
    const atBound = "y".repeat(MAX_INPUT_CHARS);
    const outcome = await persistIncomingUserTurns(store, "c1", [user("q1"), assistant("a1"), user(atBound)]);
    expect(outcome).toBeNull();
    expect(appended).toEqual([{ role: "user", content: atBound, parts: null }]);
  });
});
