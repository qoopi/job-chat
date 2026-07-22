import type { ChatSessionPersistedState } from "@trigger.dev/sdk/chat";

// Browser-durable home for the transport's per-conversation session state (token, `.out` cursor, streaming flag):
// the transport keeps it in memory, so a reload would wipe it and replay the prior turn. sessionStorage (per-tab); every accessor SSR-guarded.

const KEY_PREFIX = "jobchat_session:";

function keyFor(chatId: string): string {
  return `${KEY_PREFIX}${chatId}`;
}

export function readPersistedSession(
  chatId: string,
): ChatSessionPersistedState | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(keyFor(chatId));
    if (!raw) return undefined;
    // Self-written state, so no schema - but confirm the load-bearing field so a malformed entry reads as no session, not a garbage token.
    const parsed: unknown = JSON.parse(raw);
    return parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ChatSessionPersistedState).publicAccessToken === "string"
      ? (parsed as ChatSessionPersistedState)
      : undefined;
  } catch {
    return undefined; // private-mode / corrupt entry - treat as no persisted session
  }
}

export function writePersistedSession(
  chatId: string,
  session: ChatSessionPersistedState | null,
): void {
  if (typeof window === "undefined") return;
  try {
    if (session === null) window.sessionStorage.removeItem(keyFor(chatId));
    else window.sessionStorage.setItem(keyFor(chatId), JSON.stringify(session));
  } catch {
    // best-effort: a quota / private-mode failure must never break the chat
  }
}

export function persistedSessionIsStreaming(chatId: string): boolean {
  return readPersistedSession(chatId)?.isStreaming === true;
}
