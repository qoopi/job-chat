import { z } from "zod";
import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import { checkMessageGuards } from "./guard";

// The session core: the guard + landing-handoff logic the "use server" actions wrap. Injectable
// (store, guards, startSession, mintToken, now) so it is testable against a real store without the
// Next.js request context. Business outcomes are TYPED refusals, never thrown (engineering.md
// fail-fast-typed) - the UI branches on `reason`. Untrusted input is bounded and the caller's
// ownership is confirmed BEFORE any persist or trigger; the cap/budget are the early UX refusal
// (the hard backstop lives in the agent, trigger/chat.ts, on the write-token's real path).

/** Starts (or resumes) the durable chat session for a conversation and returns the browser's token. */
export type StartSession = (args: {
  chatId: string;
  clientData?: Record<string, unknown>;
}) => Promise<{ publicAccessToken: string; runId: string; sessionId?: string }>;

/** Mints a fresh session-scoped public token for the transport (see `chatTokenScopes`). */
export type MintToken = (conversationId: string) => Promise<string>;

export interface SessionDeps {
  store: Store;
  guards: GuardConfig;
  startSession: StartSession;
  mintToken: MintToken;
  now: () => Date;
}

export type RefusalReason = "guest_cap" | "daily_budget" | "not_found" | "invalid_input";

export type SessionOk = {
  ok: true;
  conversationId: string;
  messageId: string;
  publicAccessToken: string;
  runId: string;
};
export type SessionResult = SessionOk | { ok: false; reason: RefusalReason };

export type MintResult = { ok: true; token: string } | { ok: false; reason: "not_found" };

// Input bounds at the trust boundary (before any store write or trigger): a bounded question/text
// keeps a hostile 100KB payload out of Bedrock (token cost) and the message store (DB bloat). Trim is
// only for the empty check - the ORIGINAL text is persisted (the title derivation trims separately).
const MAX_INPUT_CHARS = 2000;
const TextSchema = z.string().trim().min(1).max(MAX_INPUT_CHARS);
const ConversationIdSchema = z.string().uuid();

/**
 * The Trigger public-token scope for a chat session: read+write to EXACTLY this conversation, never
 * broader. The standard transport reconnects with this token; the write grant is what lets the
 * browser append follow-ups (the agent-side guard is the backstop that keeps that write bounded).
 */
export function chatTokenScopes(conversationId: string) {
  return { read: { sessions: conversationId }, write: { sessions: conversationId } } as const;
}

export interface SessionService {
  /** Landing handoff (AC-3): create conversation + user message #1, trigger the run, return the id. */
  startConversation(userId: string, question: string): Promise<SessionResult>;
  /** Follow-up send: bound input, confirm the caller owns the conversation, cap/budget, persist, trigger. */
  sendMessage(conversationId: string, text: string, callerGuestId: string): Promise<SessionResult>;
  /** Mint a session-scoped token, but only for the caller's own conversation (defense in depth). */
  mintChatToken(conversationId: string, callerGuestId: string): Promise<MintResult>;
}

export function createSessionService(deps: SessionDeps): SessionService {
  const { store, guards, startSession, mintToken, now } = deps;

  async function trigger(conversationId: string, message: string): Promise<{ publicAccessToken: string; runId: string }> {
    const { publicAccessToken, runId } = await startSession({
      chatId: conversationId,
      clientData: { message },
    });
    return { publicAccessToken, runId };
  }

  return {
    async startConversation(userId, question) {
      if (!TextSchema.safeParse(question).success) return { ok: false, reason: "invalid_input" };

      const refusal = await checkMessageGuards({ store, guards, now }, userId);
      if (refusal) return { ok: false, reason: refusal };

      const conversation = await store.createConversation(userId, question);
      const message = await store.appendMessage(conversation.id, "user", question, null);
      const { publicAccessToken, runId } = await trigger(conversation.id, question);
      return { ok: true, conversationId: conversation.id, messageId: message.id, publicAccessToken, runId };
    },

    async sendMessage(conversationId, text, callerGuestId) {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      if (!TextSchema.safeParse(text).success) return { ok: false, reason: "invalid_input" };

      // Ownership: bind caller -> conversation via a lightweight owner lookup (no full history). A
      // conversation the caller does not own reads as not_found (never leak another guest's thread).
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerGuestId) return { ok: false, reason: "not_found" };

      const refusal = await checkMessageGuards({ store, guards, now }, callerGuestId);
      if (refusal) return { ok: false, reason: refusal };

      const message = await store.appendMessage(conversationId, "user", text, null);
      const { publicAccessToken, runId } = await trigger(conversationId, text);
      return { ok: true, conversationId, messageId: message.id, publicAccessToken, runId };
    },

    async mintChatToken(conversationId, callerGuestId) {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerGuestId) return { ok: false, reason: "not_found" };
      return { ok: true, token: await mintToken(conversationId) };
    },
  };
}
