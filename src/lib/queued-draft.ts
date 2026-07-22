// A capped guest's send queues the blocked draft, then "Continue with
// Google" is a FULL-PAGE redirect (to Google and back to /auth/complete -> the chat), which wipes React
// state. sessionStorage carries the draft across that same-tab round trip, keyed by conversation; on
// return - now signed in - ChatClient takes it and auto-sends exactly once. Client-only; a no-op where
// sessionStorage is unavailable (private mode / SSR), where the draft simply stays in the composer.
const key = (conversationId: string) =>
  `jobchat_queued_draft:${conversationId}`;

/** Stash the blocked draft before the sign-in redirect. */
export function queueDraft(conversationId: string, text: string): void {
  try {
    sessionStorage.setItem(key(conversationId), text);
  } catch {
    /* sessionStorage unavailable - the draft still sits in the composer as a fallback */
  }
}

/** Read + remove the queued draft (exactly-once), or null when none/blank. */
export function takeQueuedDraft(conversationId: string): string | null {
  try {
    const k = key(conversationId);
    const text = sessionStorage.getItem(k);
    if (text !== null) sessionStorage.removeItem(k);
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}
