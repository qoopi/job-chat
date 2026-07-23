import { z } from "zod";
import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import { checkMessageGuards, MAX_INPUT_CHARS, type CallerKind } from "./guard";

// The session core the actions wrap: TYPED refusals never thrown; ownership confirmed BEFORE any persist/trigger; the cap/budget are the early UX gate (agent has the hard backstop).

export type MintToken = (conversationId: string) => Promise<string>;

export interface SessionDeps {
  store: Store;
  guards: GuardConfig;
  mintToken: MintToken;
  now: () => Date;
}

export type ActionRefusalReason = "guest_cap" | "daily_budget" | "not_found" | "invalid_input";

export type SessionOk = {
  ok: true;
  conversationId: string;
  messageId: string;
};
export type SessionResult = SessionOk | { ok: false; reason: ActionRefusalReason };

export type SendOk = { ok: true };
export type SendResult = SendOk | { ok: false; reason: ActionRefusalReason };

export type MintResult = { ok: true; token: string } | { ok: false; reason: "not_found" };

export type DeleteResult = { ok: true } | { ok: false; reason: "not_found" };

export type RenameResult = { ok: true; title: string } | { ok: false; reason: "not_found" | "invalid_input" };

// Input bounds at the trust boundary (MAX_INPUT_CHARS, shared with the agent-run backstop); trim is only for the empty check - the ORIGINAL text is persisted.
const TextSchema = z.string().trim().min(1).max(MAX_INPUT_CHARS);
// A rename title is user-chosen (unlike deriveTitle's auto-cut at 60): trimmed, non-empty, capped at 120; the TRIMMED value is what persists.
const TitleSchema = z.string().trim().min(1).max(120);
const ConversationIdSchema = z.string().uuid();

/** Public-token scope: read+write to EXACTLY this conversation, never broader. */
export function chatTokenScopes(conversationId: string) {
  return { read: { sessions: conversationId }, write: { sessions: conversationId } } as const;
}

export interface SessionService {
  /** Landing handoff: validate + guard + create + persist message #1, return both ids. Does NOT trigger a run (turn 1 rides the public send path). */
  startConversation(userId: string, question: string, kind?: CallerKind): Promise<SessionResult>;
  /** Follow-up send GATE: bound input, confirm ownership, apply the cap/budget refusal. Does NOT persist/trigger/mint. */
  sendMessage(conversationId: string, text: string, callerUserId: string, kind?: CallerKind): Promise<SendResult>;
  /** Mint a session-scoped token, but only for the caller's own conversation (defense in depth). */
  mintChatToken(conversationId: string, callerUserId: string): Promise<MintResult>;
  /** Delete only the caller's OWN conversation (non-owner reads as not_found); messages cascade in the store. */
  deleteConversation(conversationId: string, callerUserId: string): Promise<DeleteResult>;
  /** Rename only the caller's OWN conversation (non-owner reads as not_found); title bound + trimmed. Returns the stored title. */
  renameConversation(conversationId: string, title: string, callerUserId: string): Promise<RenameResult>;
}

export type Identity = { userId: string; kind: CallerKind };

/** Resolve the caller's chat Identity, reconciling a Better Auth sign-in with a guest cookie (adoption); server-side, idempotent. */
export async function resolveIdentity(
  store: Store,
  args: { authUserId?: string; guestId?: string },
): Promise<Identity> {
  const { authUserId, guestId } = args;
  if (authUserId) {
    const existing = await store.findUserByAuthId(authUserId);
    if (existing) {
      if (guestId && guestId !== existing.user_id) await store.adoptGuest(existing.user_id, guestId);
      return { userId: existing.user_id, kind: "account" };
    }
    // First sign-in: stamp the auth id onto the caller's own row (store stamps ONLY an unlinked guest row); `false` = the row belongs to another account (forged cookie) or lost the UNIQUE race - re-read.
    const row = await store.getOrCreateUser(guestId ?? crypto.randomUUID());
    if (await store.linkAuthUser(row.user_id, authUserId)) return { userId: row.user_id, kind: "account" };
    const canonical = await store.findUserByAuthId(authUserId);
    if (canonical) {
      if (guestId && guestId !== canonical.user_id) await store.adoptGuest(canonical.user_id, guestId);
      return { userId: canonical.user_id, kind: "account" };
    }
    // Stamp refused = the cookie's row belongs to another account. Never bind onto/adopt from a victim's row - mint a fresh one.
    const fresh = await store.getOrCreateUser(crypto.randomUUID());
    await store.linkAuthUser(fresh.user_id, authUserId);
    return { userId: fresh.user_id, kind: "account" };
  }
  const userId = guestId ?? (await store.getOrCreateUser(crypto.randomUUID())).user_id;
  return { userId, kind: "guest" };
}

export function createSessionService(deps: SessionDeps): SessionService {
  const { store, guards, mintToken, now } = deps;

  return {
    async startConversation(userId, question, kind = "guest") {
      if (!TextSchema.safeParse(question).success) return { ok: false, reason: "invalid_input" };

      const refusal = await checkMessageGuards({ store, guards, now }, userId, kind);
      if (refusal) return { ok: false, reason: refusal };

      const conversation = await store.createConversation(userId, question);
      const message = await store.appendMessage(conversation.id, "user", question, null);
      return { ok: true, conversationId: conversation.id, messageId: message.id };
    },

    async sendMessage(conversationId, text, callerUserId, kind = "guest") {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      if (!TextSchema.safeParse(text).success) return { ok: false, reason: "invalid_input" };

      // Ownership: a conversation the caller does not own reads as not_found (never leak another user's thread).
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerUserId) return { ok: false, reason: "not_found" };

      const refusal = await checkMessageGuards({ store, guards, now }, callerUserId, kind);
      if (refusal) return { ok: false, reason: refusal };

      // A pure gate: do NOT persist/trigger/mint here - the transport delivers to `.in` and run() persists (else double-count).
      return { ok: true };
    },

    async mintChatToken(conversationId, callerUserId) {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerUserId) return { ok: false, reason: "not_found" };
      return { ok: true, token: await mintToken(conversationId) };
    },

    async deleteConversation(conversationId, callerUserId) {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerUserId) return { ok: false, reason: "not_found" };
      await store.deleteConversation(conversationId);
      return { ok: true };
    },

    async renameConversation(conversationId, title, callerUserId) {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      // Bound the title BEFORE ownership (same order as sendMessage guards text) so an over-long payload never reaches the store.
      const parsed = TitleSchema.safeParse(title);
      if (!parsed.success) return { ok: false, reason: "invalid_input" };
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerUserId) return { ok: false, reason: "not_found" };
      await store.renameConversation(conversationId, parsed.data);
      return { ok: true, title: parsed.data };
    },
  };
}
