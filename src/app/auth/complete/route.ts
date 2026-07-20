import { NextResponse } from "next/server";
import { completeSignIn } from "@/app/actions";

// The name of the unsigned guest bearer cookie (mirrors actions.ts / server-store.ts - a "use server"
// module cannot export a non-async const, so it is repeated here as those modules already do).
const GUEST_COOKIE = "jobchat_guest";

// Only ever redirect to a same-origin PATH - an attacker-supplied `next` must never become an open
// redirect. The redirect target is built with `new URL(next, origin)`, and WHATWG URL parsing normalizes
// backslashes to "/" for http(s) and strips ASCII tab/CR/LF BEFORE that - so a raw string-prefix check
// (`startsWith("/") && !startsWith("//")`) can pass a value that still resolves to a foreign origin
// (`/\evil.com`, `/\/evil.com`, a tab-embedded path). So resolve FIRST with those same rules, then require
// the resolved origin to equal ours AND a plain leading-slash (non-protocol-relative) path; return the
// resolved path so the caller re-resolves the exact same same-origin target. Anything else -> the landing.
function safeNext(raw: string | null, origin: string): string {
  if (!raw) return "/";
  let dest: URL;
  try {
    dest = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (dest.origin !== origin) return "/";
  const path = dest.pathname + dest.search + dest.hash;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

// The Google OAuth success landing (the STABLE callbackURL that AuthDialog hands Better Auth). Better
// Auth's /api/auth/callback/google sets the session cookie then full-page-redirects HERE - there is no
// client moment to run the sign-in TRANSITION, so we run it server-side: completeSignIn adopts the
// guest's conversations onto the account and clears the guest cookie (the SAME transition the removed
// email path used). Then land the now-signed-in user back where they started (`next`). A finalize
// failure OR a sessionless hit (a direct GET / replayed link with no Google round trip - completeSignIn
// returns `{ ok: false }` WITHOUT throwing) must FAIL SAFE: keep the guest cookie and land on
// `next?error=` so the dialog surfaces it - never clear the guest identity on a redirect that adopted or
// recognized nothing, and never a silent reload. `next` is confined to a same-origin path.
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"), url.origin);

  const failSafe = (): NextResponse => {
    // Do NOT clear the guest cookie (the per-request path still needs it). Surface the failure.
    const dest = new URL(next, url.origin);
    dest.searchParams.set("error", "signin_incomplete");
    return NextResponse.redirect(dest);
  };

  let ok: boolean;
  try {
    ({ ok } = await completeSignIn());
  } catch {
    return failSafe();
  }
  if (!ok) return failSafe();

  const res = NextResponse.redirect(new URL(next, url.origin));
  // Belt-and-suspenders: guarantee the guest cookie is dropped on THIS redirect response, regardless of
  // how Next merges completeSignIn's next/headers cookie mutation (idempotent with it).
  res.cookies.delete(GUEST_COOKIE);
  return res;
}
