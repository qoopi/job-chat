import { describe, expect, it, vi } from "vitest";
import type { Store } from "@shared/store";
import {
  chatTokenScopes,
  createSessionService,
  type MintToken,
  type StartSession,
} from "../../trigger/session";

// The session core's boundary logic, unit-tested without a DB (pure). Two invariants live here:
//  1. `chatTokenScopes` - the transport's public token is scoped read+write to EXACTLY one
//     conversation, never broader. This is the auth boundary the AI SDK transport (006) trusts.
//  2. Input bounds (must-fix B) - untrusted question/text is refused at the boundary BEFORE any store
//     write or trigger, so a hostile 100KB payload never reaches Bedrock or the message store.

describe("chatTokenScopes", () => {
  it("scopes read+write to exactly the given conversation - no broader grant", () => {
    const conversationId = "conv-under-test";
    // Would fail if the scope were widened (e.g. `sessions: true`) or narrowed to read-only.
    expect(chatTokenScopes(conversationId)).toEqual({
      read: { sessions: conversationId },
      write: { sessions: conversationId },
    });
  });

  it("mints a distinct scope per conversation - one guest's token never grants another's session", () => {
    const a = chatTokenScopes("conv-a");
    const b = chatTokenScopes("conv-b");
    expect(a.read.sessions).toBe("conv-a");
    expect(b.read.sessions).toBe("conv-b");
    expect(a).not.toEqual(b);
  });
});

describe("session core input bounds (must-fix B)", () => {
  // A store whose every method throws: proves invalid input is refused BEFORE any store access.
  function explodingStore(): Store {
    const boom = () => {
      throw new Error("store must not be touched on invalid input");
    };
    return {
      getOrCreateUser: boom,
      createConversation: boom,
      appendMessage: boom,
      getConversation: boom,
      getConversationOwner: boom,
      messageCounts: boom,
    } as unknown as Store;
  }

  function svc() {
    const startSession = vi.fn<StartSession>();
    const mintToken = vi.fn<MintToken>();
    return {
      startSession,
      mintToken,
      service: createSessionService({
        store: explodingStore(),
        guards: { guestCap: 10, dailyBudget: 200 },
        startSession,
        mintToken,
        now: () => new Date(),
      }),
    };
  }

  it("startConversation refuses empty/whitespace and over-long questions with invalid_input", async () => {
    const { service, startSession } = svc();
    expect(await service.startConversation("u1", "   ")).toEqual({ ok: false, reason: "invalid_input" });
    expect(await service.startConversation("u1", "")).toEqual({ ok: false, reason: "invalid_input" });
    expect(await service.startConversation("u1", "x".repeat(2001))).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(startSession).not.toHaveBeenCalled();
  });

  it("sendMessage refuses over-long text with invalid_input, and a non-UUID id with not_found", async () => {
    const { service, startSession } = svc();
    const uuid = crypto.randomUUID();
    expect(await service.sendMessage(uuid, "x".repeat(2001), "u1")).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await service.sendMessage("not-a-uuid", "hi", "u1")).toEqual({ ok: false, reason: "not_found" });
    expect(startSession).not.toHaveBeenCalled();
  });

  it("mintChatToken refuses a non-UUID id with not_found before touching the store", async () => {
    const { service, mintToken } = svc();
    expect(await service.mintChatToken("not-a-uuid", "u1")).toEqual({ ok: false, reason: "not_found" });
    expect(mintToken).not.toHaveBeenCalled();
  });
});
