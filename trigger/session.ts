import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";

// The session core: the guard + landing-handoff logic the "use server" actions wrap. Injectable
// (store, guards, startSession, now) so it is testable against a real store without the Next.js
// request context. Business outcomes are TYPED refusals, never thrown (engineering.md fail-fast-typed)
// - the UI branches on `reason`. Cap/budget are checked BEFORE any persist or trigger.

/** Starts (or resumes) the durable chat session for a conversation and returns the browser's token. */
export type StartSession = (args: {
  chatId: string;
  clientData?: Record<string, unknown>;
}) => Promise<{ publicAccessToken: string; runId: string; sessionId?: string }>;

export interface SessionDeps {
  store: Store;
  guards: GuardConfig;
  startSession: StartSession;
  now: () => Date;
}

export type RefusalReason = "guest_cap" | "daily_budget" | "not_found";

export type SessionOk = {
  ok: true;
  conversationId: string;
  messageId: string;
  publicAccessToken: string;
  runId: string;
};
export type SessionResult = SessionOk | { ok: false; reason: RefusalReason };

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface SessionService {
  /** Landing handoff (AC-3): create conversation + user message #1, trigger the run, return the id. */
  startConversation(userId: string, question: string): Promise<SessionResult>;
  /** Follow-up send: cap/budget check, persist the user turn, trigger the run. */
  sendMessage(conversationId: string, text: string): Promise<SessionResult>;
}

export function createSessionService(deps: SessionDeps): SessionService {
  const { store, guards, startSession, now } = deps;

  // Returns a refusal reason, or null when the message is allowed. Global daily budget (the spend
  // kill switch, AC-20) is checked first, then the per-guest cap (AC-15).
  async function guardCheck(userId: string): Promise<"guest_cap" | "daily_budget" | null> {
    const since = utcMidnight(now());
    const global = await store.messageCounts({ sinceUtcMidnight: since });
    if (global >= guards.dailyBudget) return "daily_budget";
    const scoped = await store.messageCounts({ userId, sinceUtcMidnight: since });
    if (scoped >= guards.guestCap) return "guest_cap";
    return null;
  }

  async function trigger(conversationId: string, message: string): Promise<{ publicAccessToken: string; runId: string }> {
    const { publicAccessToken, runId } = await startSession({
      chatId: conversationId,
      clientData: { message },
    });
    return { publicAccessToken, runId };
  }

  return {
    async startConversation(userId, question) {
      const refusal = await guardCheck(userId);
      if (refusal) return { ok: false, reason: refusal };

      const conversation = await store.createConversation(userId, question);
      const message = await store.appendMessage(conversation.id, "user", question, null);
      const { publicAccessToken, runId } = await trigger(conversation.id, question);
      return { ok: true, conversationId: conversation.id, messageId: message.id, publicAccessToken, runId };
    },

    async sendMessage(conversationId, text) {
      const found = await store.getConversation(conversationId);
      if (!found) return { ok: false, reason: "not_found" };

      const refusal = await guardCheck(found.conversation.user_id);
      if (refusal) return { ok: false, reason: refusal };

      const message = await store.appendMessage(conversationId, "user", text, null);
      const { publicAccessToken, runId } = await trigger(conversationId, text);
      return { ok: true, conversationId, messageId: message.id, publicAccessToken, runId };
    },
  };
}
