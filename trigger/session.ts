import { z } from "zod";
import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import { checkMessageGuards, MAX_INPUT_CHARS, type CallerKind } from "./guard";

// The session core: the guard + landing-handoff logic the "use server" actions wrap. Injectable
// (store, guards, mintToken, now) so it is testable against a real store without the
// Next.js request context. Business outcomes are TYPED refusals, never thrown (engineering.md
// fail-fast-typed) - the UI branches on `reason`. Untrusted input is bounded and the caller's
// ownership is confirmed BEFORE any persist or trigger; the cap/budget are the early UX refusal
// (the hard backstop lives in the agent, trigger/chat.ts, on the write-token's real path).

/** Mints a fresh session-scoped public token for the transport (see `chatTokenScopes`). */
export type MintToken = (conversationId: string) => Promise<string>;

export interface SessionDeps {
  store: Store;
  guards: GuardConfig;
  mintToken: MintToken;
  now: () => Date;
}

// The action layer's own refusal reason - a DISTINCT taxonomy from the insight-card `RefusalReason`
// (@shared/insight): a start/send action can also fail validation (`not_found`, `invalid_input`), not
// just the cap/budget guard. Named apart so the card taxonomy keeps its single shared home.
export type ActionRefusalReason = "guest_cap" | "daily_budget" | "not_found" | "invalid_input";

// Turn 1's outcome. Carries the new conversation id AND the persisted message #1's id: the client
// navigates to /chat/{conversationId} and delivers turn 1 through the SAME public send path as every
// follow-up - `sendMessage({ text, messageId })` reuses this id so the streamed turn reconciles onto the
// SSR-rendered bubble (one bubble) and the run-side count-persist stays a no-op.
export type SessionOk = {
  ok: true;
  conversationId: string;
  messageId: string;
};
export type SessionResult = SessionOk | { ok: false; reason: ActionRefusalReason };

/**
 * A follow-up send's outcome. A pure gate: it carries no token or id. The client transport owns the
 * session (token via the `accessToken` callback, lazy `startSession` on the first `sendMessage`), and
 * its `sendMessages` both delivers the turn to `.in` (triggering the run) and subscribes with wait. This
 * action is only the early UX gate - input bounds + ownership + cap/budget.
 */
export type SendOk = { ok: true };
export type SendResult = SendOk | { ok: false; reason: ActionRefusalReason };

export type MintResult = { ok: true; token: string } | { ok: false; reason: "not_found" };

/** A delete's outcome (AC-21): the row is gone, or the caller does not own it (treated as not_found). */
export type DeleteResult = { ok: true } | { ok: false; reason: "not_found" };

// Input bounds at the trust boundary (before any store write or trigger): a bounded question/text
// keeps a hostile 100KB payload out of Bedrock (token cost) and the message store (DB bloat). The
// bound (MAX_INPUT_CHARS) is shared with the agent-run ingress backstop (trigger/guard.ts) so the two
// layers cannot drift. Trim is only for the empty check - the ORIGINAL text is persisted (the title
// derivation trims separately).
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
  /**
   * Landing handoff (AC-11): validate + guard + create conversation + persist user message #1, then
   * return the conversation id AND the persisted message's id. It does NOT trigger a run - turn 1 rides
   * the client's public send path, where the transport lazily starts the session on the first
   * `sendMessage` and streams it live (same path as every follow-up). The cap is picked by the caller's
   * Identity `kind` (turn 1 has no conversation row for the backstop to read); defaults to the guest cap.
   */
  startConversation(userId: string, question: string, kind?: CallerKind): Promise<SessionResult>;
  /**
   * Follow-up send GATE (mechanism a): bound input, confirm the caller owns the conversation, and apply
   * the cap/budget early refusal (cap by Identity `kind`). It does NOT persist, trigger, or mint - the
   * client transport's `sendMessages` delivers the turn to `.in` (triggering the run) and subscribes with
   * wait (the only SDK path that streams a freshly-triggered follow-up live), and the agent's `run()`
   * persists the user turn before the backstop counts it.
   */
  sendMessage(conversationId: string, text: string, callerUserId: string, kind?: CallerKind): Promise<SendResult>;
  /** Mint a session-scoped token, but only for the caller's own conversation (defense in depth). */
  mintChatToken(conversationId: string, callerUserId: string): Promise<MintResult>;
  /**
   * Delete a conversation (AC-21), but only the caller's OWN (same ownership check as sendMessage /
   * mintChatToken - a non-owner, guest or account, reads as not_found so no one deletes another's
   * thread). Messages cascade in the store.
   */
  deleteConversation(conversationId: string, callerUserId: string): Promise<DeleteResult>;
}

/** The caller's resolved chat identity: a stable `userId` (the chat identity key) + its `kind`. */
export type Identity = { userId: string; kind: CallerKind };

/**
 * Resolve the caller's chat Identity, reconciling a fresh Better Auth sign-in with any guest cookie
 * (adoption). Runs server-side in the action path (never client-side) and is idempotent:
 * - auth id already on a users row (returning account): that row is canonical; a DIFFERENT guest
 *   cookie's conversations are adopted onto it (new-device sign-in).
 * - auth id on no row yet (first sign-in this browser): stamp it onto the caller's users row (the guest
 *   row if present, else a fresh one) so the guest's conversations become the account's for free.
 * - no auth id: the guest cookie is the identity (its users row was upserted on the landing path).
 */
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
    // First sign-in this browser: stamp the auth id onto the caller's own row (the guest row if
    // present, else a fresh one). The store stamps ONLY an unlinked guest row and returns whether it
    // did: `false` means the cookie's row already belongs to a DIFFERENT account (forged/stale cookie)
    // OR a concurrent first sign-in won the auth_user_id UNIQUE race - both need a re-read.
    const row = await store.getOrCreateUser(guestId ?? crypto.randomUUID());
    if (await store.linkAuthUser(row.user_id, authUserId)) return { userId: row.user_id, kind: "account" };
    const canonical = await store.findUserByAuthId(authUserId);
    if (canonical) {
      // A concurrent stamp won the race: that row is canonical. Adopt this device's guest
      // conversations onto it (as the returning-account branch does) - idempotent under the race, no throw.
      if (guestId && guestId !== canonical.user_id) await store.adoptGuest(canonical.user_id, guestId);
      return { userId: canonical.user_id, kind: "account" };
    }
    // No row carries this auth id, so the stamp was refused because the cookie's row is bound to
    // another account. Never bind onto or adopt from a victim's row - mint a fresh canonical row instead.
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

      // Create the conversation and persist message #1, then hand its id back. Turn 1 is delivered by
      // the client's public send path (transport lazily starts the session on the first `sendMessage`),
      // so this action never triggers a run or touches `.in`. `run()`'s user-turn persist is a no-op for
      // message #1 (count-based, see persistIncomingUserTurns).
      const conversation = await store.createConversation(userId, question);
      const message = await store.appendMessage(conversation.id, "user", question, null);
      return { ok: true, conversationId: conversation.id, messageId: message.id };
    },

    async sendMessage(conversationId, text, callerUserId, kind = "guest") {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      if (!TextSchema.safeParse(text).success) return { ok: false, reason: "invalid_input" };

      // Ownership: bind caller -> conversation via a lightweight owner lookup (no full history). A
      // conversation the caller does not own reads as not_found (never leak another user's thread).
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerUserId) return { ok: false, reason: "not_found" };

      const refusal = await checkMessageGuards({ store, guards, now }, callerUserId, kind);
      if (refusal) return { ok: false, reason: refusal };

      // Mechanism (a): a pure gate. Do NOT persist, trigger, or mint here. The client transport's
      // `sendMessages` delivers this turn to `.in` (triggering the run) AND subscribes with wait - the
      // only SDK path that streams a freshly-triggered follow-up live - and refreshes its own token via
      // the `accessToken` callback. `run()` persists the user turn before the backstop counts it
      // (persistIncomingUserTurns). Persisting here too would double-persist and double-count the guard.
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
      // Same ownership gate as sendMessage/mintChatToken: a conversation the caller does not own reads
      // as not_found (never delete another user's thread), and the store cascades the messages.
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerUserId) return { ok: false, reason: "not_found" };
      await store.deleteConversation(conversationId);
      return { ok: true };
    },
  };
}
