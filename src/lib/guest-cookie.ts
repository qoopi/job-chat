// AC-16: the one home for the guest bearer-cookie name. Three server modules read it (actions.ts,
// server-store.ts, auth/complete/route.ts); a drift here would silently split guest identity (reads
// miss writes), so the literal lives once. A plain leaf const module - no "use server"/"server-only"
// so any of them can import it. (The name is not a secret; the id it holds is an unsigned bearer value.)
export const GUEST_COOKIE = "jobchat_guest";
