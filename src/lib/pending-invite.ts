// The Google sign-in is a FULL-PAGE redirect that wipes React state; a sessionStorage flag carries the profile-invite intent across it (no-op if unavailable).
const key = (conversationId: string) => `jobchat_pending_profile_invite:${conversationId}`;

export function queuePendingProfileInvite(conversationId: string): void {
  try {
    sessionStorage.setItem(key(conversationId), "1");
  } catch {
    /* sessionStorage unavailable - the invite simply won't auto-surface (the user can still add a profile) */
  }
}

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
