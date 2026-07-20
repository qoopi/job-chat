import { z } from "zod";
import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import { checkMessageGuards, MAX_INPUT_CHARS, type CallerKind } from "./guard";

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

/**
 * Posts one record to a conversation's durable session inbox (`.in`) - the SDK seam the agent run
 * consumes user turns from. Injected (the real impl is `sessions.open(chatId).in.send(chunk)` in the
 * "use server" adapter) so the core stays pure and testable without the Trigger runtime.
 */
export type SendToInbox = (chatId: string, chunk: unknown) => Promise<void>;

export interface SessionDeps {
  store: Store;
  guards: GuardConfig;
  startSession: StartSession;
  mintToken: MintToken;
  sendToInbox: SendToInbox;
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

/**
 * A follow-up send's outcome. On success it carries ONLY the session-scoped token the client transport
 * attaches with - NOT a messageId/runId: a follow-up does not persist or trigger server-side. The client
 * transport's `sendMessages` delivers the turn to `.in` (which triggers the run) and subscribes with
 * wait - the only SDK 4.5.4 path that streams a freshly-triggered follow-up live (see `sendMessage`).
 */
export type SendOk = { ok: true; publicAccessToken: string };
export type SendResult = SendOk | { ok: false; reason: RefusalReason };

export type MintResult = { ok: true; token: string } | { ok: false; reason: "not_found" };

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

/**
 * The `ChatInputChunk` envelope a user turn takes on the session inbox (`.in`). This is the exact
 * shape the SDK's inbox drain surfaces as a user message: `replaySessionInTail` keeps only records
 * whose `kind` is "message" and whose `payload.trigger` is "submit-message" carrying a
 * `payload.message`, and `extractLastUserMessageText` reads the text from the message's `text` parts.
 * It mirrors what the browser transport's `sendRaw` posts, so the preloaded agent run - which waits on
 * `.in` before it ever calls `run()` - consumes the turn server-side instead of idling until timeout.
 *
 * VERSION-PINNED to @trigger.dev/sdk 4.5.4 (pinned EXACT in package.json - no caret - for this reason).
 * This reproduces a PRIVATE SDK envelope, NOT a public API: `replaySessionInTail` /
 * `extractLastUserMessageText` (SDK dist ai.js) are internals. On ANY @trigger.dev/sdk bump, re-verify
 * that {kind:"message", payload:{trigger:"submit-message", chatId, message}} still round-trips through
 * that drain before shipping - a silent drift here breaks user-turn delivery (the agent boots as a
 * preload and idles forever) with NO automated guard, because every inbox test mocks `sendToInbox`.
 * Only the operator's manual live smoke (007) exercises the real drain.
 */
export function userTurnChunk(chatId: string, messageId: string, text: string) {
  return {
    kind: "message",
    payload: {
      trigger: "submit-message",
      chatId,
      message: { id: messageId, role: "user", parts: [{ type: "text", text }] },
    },
  } as const;
}

export interface SessionService {
  /**
   * Landing handoff (AC-3): create conversation + user message #1, trigger the run, return the id. The
   * cap is picked by the caller's Identity `kind` (turn 1 has no conversation row for the backstop to
   * read); defaults to the guest cap.
   */
  startConversation(userId: string, question: string, kind?: CallerKind): Promise<SessionResult>;
  /**
   * Follow-up send GATE (mechanism a): bound input, confirm the caller owns the conversation, apply the
   * cap/budget early refusal (cap by Identity `kind`), and mint the scoped token. It does NOT persist or
   * trigger - the client transport's `sendMessages` delivers the turn to `.in` (triggering the run) and
   * subscribes with wait (the only SDK path that streams a freshly-triggered follow-up live), and the
   * agent's `run()` persists the user turn before the backstop counts it.
   */
  sendMessage(conversationId: string, text: string, callerUserId: string, kind?: CallerKind): Promise<SendResult>;
  /** Mint a session-scoped token, but only for the caller's own conversation (defense in depth). */
  mintChatToken(conversationId: string, callerUserId: string): Promise<MintResult>;
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
    const row = await store.getOrCreateUser(guestId ?? crypto.randomUUID());
    await store.linkAuthUser(row.user_id, authUserId);
    return { userId: row.user_id, kind: "account" };
  }
  const userId = guestId ?? (await store.getOrCreateUser(crypto.randomUUID())).user_id;
  return { userId, kind: "guest" };
}

export function createSessionService(deps: SessionDeps): SessionService {
  const { store, guards, startSession, mintToken, sendToInbox, now } = deps;

  // Turn-1 (landing) ONLY: start the durable session, THEN deliver message #1 to its inbox. The order
  // matters: `startSession` fires a PRELOAD run that boots with empty messages and blocks on `.in` before
  // it ever reaches the agent's `run()` (SDK ai.js: the preload wait sits ahead of the turn loop), and on
  // arrival the browser only reconnects to watch - it does not `sendMessages` (that would double-deliver
  // message #1), so this server-side append is what lands the first turn on Bedrock. Follow-ups take the
  // OTHER path: the browser's `sendMessages` both appends to `.in` and subscribes with wait, so they never
  // come through here (see `sendMessage`). Message #1 is already persisted by `startConversation` before
  // we get here; `run()`'s persist is a no-op for it (count-based, see persistIncomingUserTurns).
  async function trigger(
    conversationId: string,
    messageId: string,
    text: string,
  ): Promise<{ publicAccessToken: string; runId: string }> {
    const { publicAccessToken, runId } = await startSession({
      chatId: conversationId,
      clientData: { message: text },
    });
    await sendToInbox(conversationId, userTurnChunk(conversationId, messageId, text));
    return { publicAccessToken, runId };
  }

  return {
    async startConversation(userId, question, kind = "guest") {
      if (!TextSchema.safeParse(question).success) return { ok: false, reason: "invalid_input" };

      const refusal = await checkMessageGuards({ store, guards, now }, userId, kind);
      if (refusal) return { ok: false, reason: refusal };

      const conversation = await store.createConversation(userId, question);
      const message = await store.appendMessage(conversation.id, "user", question, null);
      const { publicAccessToken, runId } = await trigger(conversation.id, message.id, question);
      return { ok: true, conversationId: conversation.id, messageId: message.id, publicAccessToken, runId };
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

      // Mechanism (a): do NOT persist or trigger here. The client transport's `sendMessages` delivers
      // this turn to `.in` (which triggers the run) AND subscribes with wait - the only SDK 4.5.4 path
      // that streams a freshly-triggered follow-up live (`reconnectToStream` forces peekSettled and never
      // delivers a fresh run's chunks). So this action is the early UX gate (input bounds + ownership +
      // cap/budget) and mints the scoped token the transport attaches with; `run()` persists the user
      // turn before the backstop counts it (persistIncomingUserTurns). Persisting here too would
      // double-persist (run() re-persists from its rebuilt history) and double-count the guard.
      return { ok: true, publicAccessToken: await mintToken(conversationId) };
    },

    async mintChatToken(conversationId, callerUserId) {
      if (!ConversationIdSchema.safeParse(conversationId).success) return { ok: false, reason: "not_found" };
      const owner = await store.getConversationOwner(conversationId);
      if (!owner || owner.user_id !== callerUserId) return { ok: false, reason: "not_found" };
      return { ok: true, token: await mintToken(conversationId) };
    },
  };
}
