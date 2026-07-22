import { describe, expect, it } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import type { Store, Message } from "@shared/store";
import { hydrateHistory, persistIncomingUserTurns, type RunMessage } from "../../trigger/persistence";

// R6 (F11): registering the SDK's `hydrateMessages` seam switches the built-in snapshot machinery OFF -
// Postgres becomes the sole chat-history store. The seam returns the DB history for the SDK's accumulator;
// `createChatRun` still owns the MODEL-input rebuild (buildModelHistory over the store), so the seam
// return is deliberately RAW: the persisted rows verbatim (row ids, no coalescing, no verdict
// substitution) with the incoming wire turn appended. Keeping it raw is what makes the user COUNT that
// `persistIncomingUserTurns` reads identical to the pre-seam replay accumulator - the error-turn coalesce
// that would drift the count cannot occur because nothing here coalesces.

const text = (m: UIMessage): string =>
  m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("hydrateHistory (the SDK hydrateMessages seam)", () => {
  it("Should_ServeHistoryFromStore_When_HydrateSeamCalled: raw persisted rows + incoming, no snapshot", () => {
    const persisted = [
      { id: "r1", role: "user" as const, content: "q1" },
      // An assistant turn whose PROSE differs from any code-derived verdict: proving the seam serves the
      // stored content VERBATIM (no verdict substitution, no empty-drop) - that transform belongs to
      // createChatRun's model rebuild, never here.
      { id: "r2", role: "assistant" as const, content: "Apple and Meta are also ramping up hiring." },
    ];
    const incoming: UIMessage[] = [{ id: "w1", role: "user", parts: [{ type: "text", text: "q2" }] }];

    const out = hydrateHistory(persisted, incoming);

    // Row ids preserved; the incoming wire turn appended once; NOTHING sourced from a snapshot (length is
    // exactly the store rows plus the one new incoming turn).
    expect(out.map((m) => m.id)).toEqual(["r1", "r2", "w1"]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out).toHaveLength(persisted.length + incoming.length);
    // Verbatim content - no coalescing, no verdict substitution.
    expect(text(out[0])).toBe("q1");
    expect(text(out[1])).toBe("Apple and Meta are also ramping up hiring.");
    expect(text(out[2])).toBe("q2");
  });

  it("does not re-append an incoming turn already present in the store (id dedupe)", () => {
    const persisted = [{ id: "r1", role: "user" as const, content: "q1" }];
    // A redelivery of the already-persisted turn (same wire id as a stored row) must not double it.
    const incoming: UIMessage[] = [{ id: "r1", role: "user", parts: [{ type: "text", text: "q1" }] }];

    const out = hydrateHistory(persisted, incoming);

    expect(out.map((m) => m.id)).toEqual(["r1"]);
  });

  it("count-semantics: an error turn between two users flows through unchanged (drift closed by construction)", async () => {
    // The drift case: an errored assistant turn (content "") sits between two user turns. If the seam
    // coalesced (as buildModelHistory does for the MODEL), the two users would merge into one and
    // persistIncomingUserTurns would under-count and miss the new turn. The raw seam keeps them distinct.
    const persisted = [
      { id: "r1", role: "user" as const, content: "q1" },
      { id: "r2", role: "assistant" as const, content: "" }, // the error card turn
    ];
    const incoming: UIMessage[] = [{ id: "w1", role: "user", parts: [{ type: "text", text: "q2" }] }];

    const hydrated = hydrateHistory(persisted, incoming);
    // The seam keeps BOTH user turns distinct (no coalesce): two user rows survive into the accumulator.
    expect(hydrated.filter((m) => m.role === "user")).toHaveLength(2);

    // Drive the exact production bridge: the SDK converts the seam return with convertToModelMessages,
    // and createChatRun hands THAT to persistIncomingUserTurns. The store holds only [q1, error] (one
    // user), so the one new user turn (q2) must be detected and persisted.
    const model = (await convertToModelMessages(hydrated)) as RunMessage[];

    const appended: Array<{ role: string; content: string }> = [];
    const store = {
      getConversation: async () => ({
        conversation: {} as never,
        messages: persisted.map((m) => ({ ...m, parts: null }) as unknown as Message),
      }),
      appendMessage: async (_c: string, role: "user" | "assistant", content: string) => {
        appended.push({ role, content });
        return { role, content } as unknown as Message;
      },
    } as unknown as Store;

    const outcome = await persistIncomingUserTurns(store, "c1", model);

    expect(outcome).toBeNull();
    expect(appended).toEqual([{ role: "user", content: "q2" }]);
  });
});
