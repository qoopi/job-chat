// The auth-invite's pending action: clicking "Sign in with Google" opens the auth dialog, whose Google
// path is a FULL-PAGE redirect that wipes React state. A sessionStorage flag (keyed by the destination
// conversation, exactly like queued-draft) carries the intent across that round trip; on the genuine
// post-auth return (fromAuth), ChatClient surfaces the profile-invite card in the thread. Client-only; a
// no-op where sessionStorage is unavailable (private mode / SSR).
const key = (conversationId: string) => `jobchat_pending_profile_invite:${conversationId}`;

/** Mark that a profile-invite should be surfaced after the sign-in redirect returns. */
export function queuePendingProfileInvite(conversationId: string): void {
  try {
    sessionStorage.setItem(key(conversationId), "1");
  } catch {
    /* sessionStorage unavailable - the invite simply won't auto-surface (the user can still add a profile) */
  }
}

/** Read + clear the pending-invite flag (exactly-once), true when it was set. */
export function takePendingProfileInvite(conversationId: string): boolean {
  try {
    const k = key(conversationId);
    const present = sessionStorage.getItem(k) === "1";
    if (present) sessionStorage.removeItem(k);
    return present;
  } catch {
    return false;
  }
}
