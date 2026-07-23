import { describe, expect, test } from "vitest";
import type { UIMessage } from "ai";
import { dedupeDataPartsById } from "@/lib/chat-ui";

// A persisted data card (a postings/insight part with a STABLE id) can be re-emitted under that SAME id in a
// SECOND message when a stalled run reconnects cursor-less and the .out tail replays an already-hydrated turn
// - a copy the message-id fold cannot collapse. This presentation pass keeps the FIRST message's copy of each
// data-part id, drops a later message's repeat, and drops an assistant message the drop left empty. A part id
// repeated WITHIN one message is the skeleton->filled reconciliation, not a duplicate, and is never dropped.

function postings(msgId: string, partId: string, total = 8947): UIMessage {
  return {
    id: msgId,
    role: "assistant",
    parts: [{ type: "data-postings", id: partId, data: { kind: "postings", rows: [], total } } as UIMessage["parts"][number]],
  } as UIMessage;
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

describe("dedupeDataPartsById", () => {
  test("drops a replayed data card copied into a later message (same part id, different message id)", () => {
    const out = dedupeDataPartsById([
      user("u1", "find me a job that fits"),
      postings("m1", "call-search"),
      postings("m2", "call-search"), // the .out replay re-emits the same part id under a new message id
    ]);
    expect(out.map((m) => m.id)).toEqual(["u1", "m1"]); // the emptied replay message is dropped
    const kept = out.filter((m) => m.role === "assistant");
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("m1"); // the first-seen copy wins
  });

  test("keeps a within-message skeleton->fill under the same id (reconciliation, not a duplicate)", () => {
    const reconciled = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "data-insight", id: "call-x", data: { status: "loading", kind: "chart" } },
        { type: "data-insight", id: "call-x", data: { id: "call-x", kind: "chart", verdict: "42 open." } },
      ],
    } as UIMessage;
    const out = dedupeDataPartsById([reconciled]);
    expect(out).toHaveLength(1);
    expect(out[0].parts).toHaveLength(2); // both same-id parts survive - the pass never touches within-message
  });

  test("keeps legitimate distinct cards of the same kind (different ids)", () => {
    const out = dedupeDataPartsById([
      postings("m1", "call-a", 12),
      postings("m2", "call-b", 34), // a genuinely different search -> a different part id
    ]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("drops only the duplicate part, keeping a message that still has other content", () => {
    const mixed = {
      id: "m2",
      role: "assistant",
      parts: [
        { type: "text", text: "Here again." },
        { type: "data-postings", id: "call-search", data: { kind: "postings", rows: [], total: 8947 } },
      ],
    } as UIMessage;
    const out = dedupeDataPartsById([postings("m1", "call-search"), mixed]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
    const kept = out.find((m) => m.id === "m2")!;
    expect(kept.parts.some((p) => p.type === "text")).toBe(true);
    expect(kept.parts.some((p) => p.type === "data-postings")).toBe(false);
  });

  test("returns unchanged messages by identity (memo-safe) when nothing is deduped", () => {
    const msgs = [user("u1", "hi"), postings("m1", "call-a")];
    const out = dedupeDataPartsById(msgs);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });
});
