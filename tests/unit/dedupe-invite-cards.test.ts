import { describe, expect, test } from "vitest";
import type { UIMessage } from "ai";
import { dataParts, dedupeInviteCards } from "@/lib/chat-ui";

// F1: the fit-intent invite cards are idempotent prompts emitted from several UNCOORDINATED sources
// (client inject on the fromAuth return, a resume re-stream, an .out cursor replay after a stall), each
// under a DIFFERENT message id - so reconcileMessagesById's id-fold can NOT collapse them. This
// presentation pass keeps the FIRST card of each invite kind and drops the later duplicate parts, and
// drops an assistant message the drop left with nothing to render.

function invite(id: string, kind: "auth-invite" | "profile-invite"): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: `data-${kind}`, id: `${id}-p`, data: { kind } } as UIMessage["parts"][number]],
  } as UIMessage;
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

describe("dedupeInviteCards", () => {
  test("keeps the first profile-invite, drops later duplicates (different ids)", () => {
    const out = dedupeInviteCards([
      user("u1", "find me a job that fits"),
      invite("a", "profile-invite"),
      invite("b", "profile-invite"),
      invite("c", "profile-invite"),
    ]);
    const invites = out.filter((m) =>
      dataParts(m).some((p) => (p.data as { kind?: string }).kind === "profile-invite"),
    );
    expect(invites).toHaveLength(1);
    expect(invites[0].id).toBe("a"); // the first-seen card wins
    expect(out.map((m) => m.id)).toEqual(["u1", "a"]); // the emptied duplicate messages are dropped
  });

  test("dedupes per kind - one auth-invite and one profile-invite both survive", () => {
    const out = dedupeInviteCards([
      invite("a", "auth-invite"),
      invite("b", "auth-invite"),
      invite("c", "profile-invite"),
      invite("d", "profile-invite"),
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "c"]);
  });

  test("keeps a message that still has renderable content after the invite part drops", () => {
    const mixed = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "Here you go." },
        { type: "data-profile-invite", id: "m1-inv", data: { kind: "profile-invite" } },
      ],
    } as UIMessage;
    const out = dedupeInviteCards([invite("a", "profile-invite"), mixed]);
    // the first invite renders; the mixed message's duplicate invite part drops but its text survives
    expect(out.map((m) => m.id)).toEqual(["a", "m1"]);
    const kept = out.find((m) => m.id === "m1")!;
    expect(kept.parts.some((p) => p.type === "text")).toBe(true);
    expect(kept.parts.some((p) => p.type === "data-profile-invite")).toBe(false);
  });

  test("returns unchanged messages by identity (memo-safe) when nothing is deduped", () => {
    const msgs = [user("u1", "hi"), invite("a", "profile-invite")];
    const out = dedupeInviteCards(msgs);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });
});
