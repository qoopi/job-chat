// A capped guest's blocked draft is stashed before the FULL-PAGE Google redirect (which wipes React state) and auto-sent once on return. No-op if sessionStorage unavailable.
const key = (conversationId: string) =>
  `jobchat_queued_draft:${conversationId}`;

export function queueDraft(conversationId: string, text: string): void {
  try {
    sessionStorage.setItem(key(conversationId), text);
  } catch {
    /* sessionStorage unavailable - the draft still sits in the composer as a fallback */
  }
}

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
