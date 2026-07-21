import type { ChatSessionPersistedState } from "@trigger.dev/sdk/chat";

// The browser-durable home for the Trigger chat transport's per-conversation session state (F1). The
// transport keeps that state - the scoped token, the `.out` cursor (`lastEventId`), and whether a turn
// is streaming - in memory only, so a reload wipes it: `reconnectToStream` then has nothing to resume
// from and a follow-up subscribes cursor-less, replaying the prior turn into the new answer. Persisting
// it here, keyed per conversation, lets the transport hydrate on the next mount - a settled turn no-ops,
// a live one resumes from the cursor. sessionStorage (per-tab, not localStorage) matches a session's
// lifetime. Every accessor is SSR-guarded: this module is imported into client components that also
// render on the server, where `window` is undefined.

const KEY_PREFIX = "jobchat_session:";

function keyFor(chatId: string): string {
  return `${KEY_PREFIX}${chatId}`;
}

/** The persisted session for a conversation, or undefined when none is stored (or on the server). */
export function readPersistedSession(
  chatId: string,
): ChatSessionPersistedState | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(keyFor(chatId));
    return raw ? (JSON.parse(raw) as ChatSessionPersistedState) : undefined;
  } catch {
    return undefined; // private-mode / corrupt entry - treat as no persisted session
  }
}

/**
 * Persist (or, on null, clear) a conversation's session state. Wired to the transport's
 * `onSessionChange`, so it fires on token refresh, every `.out` cursor advance, and stream start/stop -
 * keeping the stored state fresh for a mid-stream reload. A null clears the key when the session closes.
 */
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

/** True when a persisted session is mid-stream, so the mount should resume it (drives useChat `resume`). */
export function persistedSessionIsStreaming(chatId: string): boolean {
  return readPersistedSession(chatId)?.isStreaming === true;
}
