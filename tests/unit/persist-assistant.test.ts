import { describe, expect, it } from "vitest";
import type { Message, Store } from "@shared/store";
import { extractAssistantPersistence, persistAssistantTurn } from "../../trigger/persistence";
import { buildInsight } from "../../trigger/parts";

// A turn that fails is a TURN - it persists its assistant row with the error card, so a
// reload renders the card with Retry rather than a bare unanswered question. The load-bearing correction
// (chat-agent conformance #3): an errored turn fires onTurnComplete with `error` set and the response
// message UNDEFINED-or-partial, so persistence must branch on `error`, not bail on a missing response.

/** A fake store recording every appendMessage call (nothing else is touched). */
function fakeStore() {
  const appended: Array<{
    role: string;
    content: string;
    parts: unknown;
    id: string | undefined;
  }> = [];
  const store = {
    appendMessage: async (
      _conversationId: string,
      role: "user" | "assistant",
      content: string,
      parts: unknown,
      id?: string,
    ) => {
      appended.push({ role, content, parts, id });
      return { id: id ?? "minted", role, content, parts } as unknown as Message;
    },
  } as unknown as Store;
  return { store, appended };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("persistAssistantTurn persists failed turns as turns (AC-6/7)", () => {
  it("Should_PersistErrorCardTurn_When_ToolFails: a response carrying the error card persists it under the response id", async () => {
    const { store, appended } = fakeStore();
    // The tool caught its failure, cleared the skeleton with a data-error part; the turn completed with a
    // response message carrying that card (no `error` set at the SDK level).
    const responseMessage = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "assistant",
      parts: [
        { type: "text", text: "Something went wrong on my side - please try again." },
        { type: "data-error", id: "call-1", data: { kind: "system" } },
      ],
    };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });

    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe("assistant");
    expect(appended[0].parts).toEqual({ kind: "system" }); // the error card is the persisted surface
    expect(appended[0].id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); // keyed by the response id
  });

  it("Should_SynthesizeErrorCard_When_TurnErrorsWithoutResponse: a bare error persists a system card under a fresh uuid", async () => {
    const { store, appended } = fakeStore();
    // The SDK-level error path: onTurnComplete fires with `error` set and NO response message. The current
    // `if (!responseMessage) return` dropped exactly this turn; it must now synthesize the error card.
    await persistAssistantTurn(store, {
      conversationId: "c1",
      responseMessage: undefined,
      error: new Error("Bedrock exploded"),
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe("assistant");
    expect(appended[0].content).toBe(""); // an error card persists no prose
    expect(appended[0].parts).toEqual({ kind: "system" }); // synthesized error card
    expect(appended[0].id).toMatch(UUID_RE); // a fresh uuid (no response id to key on)
  });

  it("Should_PersistErrorCard_When_PartialResponseHasNoCard: an errored partial with prose but no card still resumes with Retry", async () => {
    const { store, appended } = fakeStore();
    // A partial response (aborted mid-answer) that carried only lead-in text - no card. With `error` set,
    // it must still persist the error card so the failed turn resumes with Retry, keyed by the response id.
    const responseMessage = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      role: "assistant",
      parts: [{ type: "text", text: "Let me check that" }],
    };
    await persistAssistantTurn(store, {
      conversationId: "c1",
      responseMessage,
      error: "stream failed",
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].parts).toEqual({ kind: "system" });
    expect(appended[0].id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("persists a real answer card even on a partial errored turn (a card produced before the error is kept)", async () => {
    const { store, appended } = fakeStore();
    const card = buildInsight({
      id: "m1",
      tool: "top_companies",
      params: {},
      result: {
        sql: "SELECT 1",
        rows: [{ company: "Google", count: 4 }],
        meta: { sampleN: 10, freshestAt: "2026-07-18 06:00:00" },
      },
    });
    const responseMessage = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      role: "assistant",
      parts: [{ type: "data-insight", id: "m1", data: card }],
    };
    await persistAssistantTurn(store, {
      conversationId: "c1",
      responseMessage,
      error: "errored on a later step",
    });
    expect(appended[0].parts).toEqual(card); // the genuine answer wins over a synthesized error card
  });

  it("persists NOTHING when there is neither a response message nor an error (a manual pipe completion)", async () => {
    const { store, appended } = fakeStore();
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage: undefined });
    expect(appended).toEqual([]);
  });

  it("persists a normal successful turn unchanged (no error branch taken)", async () => {
    const { store, appended } = fakeStore();
    const responseMessage = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      role: "assistant",
      parts: [{ type: "text", text: "Two words." }],
    };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });
    expect(appended).toHaveLength(1);
    expect(appended[0].content).toBe("Two words.");
    expect(appended[0].parts).toBeNull();
    expect(appended[0].id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });
});

// Persistence acceptance for the three remaining part kinds (030): a postings / auth-invite /
// profile-invite part must extract + persist as its strict payload (render once on reload), exactly as
// the profile-card kind (028) and the insight/error/refusal kinds do. A skeleton or malformed shape must
// still be dropped, so a failed turn never resumes as a stuck card.
describe("extractAssistantPersistence accepts the postings + invite kinds (AC-1/AC-7)", () => {
  const postings = {
    kind: "postings",
    rows: [
      { title: "Senior Backend Engineer", company: "Google", city: "Berlin", remote: true, salaryMin: 150000, salaryMax: 190000, experience: "Senior", publishedAt: "2026-07-18 10:00:00", score: 9 },
    ],
    total: 23,
  };

  it("extracts a data-postings payload (score-ordered rows + total) as the persisted surface", () => {
    const { parts } = extractAssistantPersistence({
      parts: [{ type: "data-postings", id: "call-1", data: postings }],
    });
    expect(parts).toEqual(postings);
  });

  it("extracts the auth-invite and profile-invite marker payloads", () => {
    expect(
      extractAssistantPersistence({ parts: [{ type: "data-auth-invite", id: "call-1", data: { kind: "auth-invite" } }] }).parts,
    ).toEqual({ kind: "auth-invite" });
    expect(
      extractAssistantPersistence({ parts: [{ type: "data-profile-invite", id: "call-1", data: { kind: "profile-invite" } }] }).parts,
    ).toEqual({ kind: "profile-invite" });
  });

  it("drops a malformed postings payload (shape drift never persists as a stuck card)", () => {
    const { parts } = extractAssistantPersistence({
      parts: [{ type: "data-postings", id: "call-1", data: { kind: "postings", rows: "oops" } }],
    });
    expect(parts).toBeNull();
  });

  it("persists a postings turn's payload through the store (round-trips as the postings card)", async () => {
    const { store, appended } = fakeStore();
    const responseMessage = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      role: "assistant",
      parts: [{ type: "data-postings", id: "call-1", data: postings }],
    };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });
    expect(appended).toHaveLength(1);
    expect(appended[0].parts).toEqual(postings);
    expect(appended[0].id).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  });
});
