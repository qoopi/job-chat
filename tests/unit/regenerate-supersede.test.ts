import { describe, expect, it } from "vitest";
import { createChatRun, type ChatRunArgs, type ChatRunDeps, type StreamModel } from "../../trigger/run";
import { persistAssistantTurn } from "../../trigger/persistence";
import { storeToUiMessages } from "../../src/lib/chat-ui";
import { classifyCardData } from "../../src/lib/chat-ui";
import type { Message, Store } from "@shared/store";

// A successful regenerate
// SUPERSEDES the persisted error row - exactly ONE assistant reply per user turn. The durable store
// mirrors the SDK's trailing-assistant pop (ai.js:3977-3980 trims trailing assistant messages from the
// accumulator until the tail is a user, then re-runs): on a regenerate the run gate deletes the trailing
// assistant row(s) after the last user turn BEFORE the retry's answer persists. So a reload never renders
// the stale error card above the retry's answer, and a regenerate never duplicates a prior answer.
// The bug this pins: `[user, error-card]` + a successful regenerate used to end `[user, error,
// answer]` - two assistant rows, the error card resurfacing on resume.

/**
 * A minimal STATEFUL in-memory store: real append/read plus a working `deleteTrailingAssistant`, so the
 * full regenerate turn (gate pops the superseded row, onTurnComplete appends the answer) is driven end to
 * end and the resulting tail is observable. Ordering mirrors the real store (append order == read order).
 */
function memoryStore(seed: Array<{ role: "user" | "assistant"; content: string; parts?: unknown }>) {
  let seq = 0;
  const messages: Message[] = seed.map((m) => ({
    id: crypto.randomUUID(),
    conversation_id: "c1",
    role: m.role,
    content: m.content,
    parts: (m.parts ?? null) as Message["parts"],
    created_at: new Date(1_000 + seq++),
  }));
  const store = {
    getConversationOwner: async () => ({ user_id: "u1", auth_user_id: null }),
    messageCounts: async () => 0,
    getConversation: async () => ({
      conversation: { id: "c1", user_id: "u1", title: "t", created_at: new Date() },
      messages: [...messages],
    }),
    appendMessage: async (
      _c: string,
      role: "user" | "assistant",
      content: string,
      parts: unknown,
      id?: string,
    ) => {
      const row: Message = {
        id: id ?? crypto.randomUUID(),
        conversation_id: "c1",
        role,
        content,
        parts: (parts ?? null) as Message["parts"],
        created_at: new Date(1_000 + seq++),
      };
      // ON CONFLICT (id) DO NOTHING: a supplied id already present is a silent no-op.
      if (id !== undefined && messages.some((m) => m.id === id)) return row;
      messages.push(row);
      return row;
    },
    // The narrow capability under test: drop the assistant row(s) trailing the last user message.
    deleteTrailingAssistant: async () => {
      while (messages.length > 0 && messages[messages.length - 1].role !== "user") messages.pop();
    },
  } as unknown as Store;
  return { store, messages };
}

const deps = (store: Store): ChatRunDeps<"answered"> => ({
  withStore: <T>(fn: (s: Store) => Promise<T>) => fn(store),
  guards: { guestCap: 1_000_000_000, dailyBudget: 1_000_000_000 },
  emit: () => {},
  now: () => new Date(),
  system: "BASE PROMPT",
  streamModel: (() => "answered") as StreamModel<"answered">,
});

const regenArgs = (question: string): ChatRunArgs => ({
  chatId: "c1",
  messages: [{ role: "user", content: question }],
  trigger: "regenerate-message",
  tools: {},
  signal: new AbortController().signal,
});

/** onTurnComplete for a successful turn: the SDK mints a FRESH response id on a regenerate (no trailing
 *  assistant left to reuse - ai.js:4298-4307), so the answer would append as a NEW row. */
async function persistSuccessfulAnswer(store: Store, text: string) {
  await persistAssistantTurn(store, {
    conversationId: "c1",
    responseMessage: { id: crypto.randomUUID(), parts: [{ type: "text", text }] },
  });
}

describe("a successful regenerate supersedes the persisted error row (R3 must-fix, I4/AC-6/AC-8)", () => {
  it("Should_SupersedeErrorRow_When_RegenerateSucceeds: tail is user->answer, ONE assistant row, no error card on resume", async () => {
    // Arrange: a failed turn persisted its error card - the tail is [user, error-card].
    const { store, messages } = memoryStore([
      { role: "user", content: "Median salary in SF?" },
      { role: "assistant", content: "", parts: { kind: "system" } },
    ]);
    const run = createChatRun(deps(store));

    // Act: the regenerate turn runs (gate pops the error row) then its answer persists (onTurnComplete).
    const res = await run(regenArgs("Median salary in SF?"));
    await persistSuccessfulAnswer(store, "The median salary in SF is 182k.");

    // Assert: the conversation tail is exactly user -> answer, with a single assistant row.
    expect(res).toBe("answered");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages[messages.length - 1].content).toBe("The median salary in SF is 182k.");

    // Assert: the resume render (storeToUiMessages hydrates the reload) carries NO error card.
    const resumed = storeToUiMessages(
      messages.map((m) => ({ id: m.id, role: m.role, content: m.content, parts: m.parts })),
    );
    const hasErrorPart = resumed.some((m) => m.parts.some((p) => p.type === "data-error"));
    expect(hasErrorPart).toBe(false);
    const assistantPayloads = messages
      .filter((m) => m.role === "assistant" && m.parts != null)
      .map((m) => m.parts);
    expect(assistantPayloads.every((p) => classifyCardData(p).kind !== "error")).toBe(true);
  });

  it("Should_NotDuplicateAnswer_When_RegenerateOverSuccessfulAnswer (AC-8): the prior answer is superseded, not duplicated", async () => {
    // The sibling path: a regenerate over an already-successful answer must replace it, never append a
    // second answer row ("without duplicating any prior answer").
    const { store, messages } = memoryStore([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: "Google leads with 4 of 10 postings." },
    ]);
    const run = createChatRun(deps(store));

    await run(regenArgs("Who is hiring the most?"));
    await persistSuccessfulAnswer(store, "Google leads with 6 of 12 postings.");

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages[messages.length - 1].content).toBe("Google leads with 6 of 12 postings.");
  });
});
