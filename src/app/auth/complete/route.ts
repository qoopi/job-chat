import { NextResponse } from "next/server";
import { completeSignIn } from "@/app/actions";
import { GUEST_COOKIE } from "@/lib/guest-cookie";

// SECURITY: only redirect to a same-origin PATH (attacker `next` must never be an open redirect). A raw prefix
// check can pass a foreign-resolving value (`/\evil.com`) since WHATWG normalizes `\`; resolve FIRST, then require our origin + a plain leading slash.
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

// Google OAuth success landing: Better Auth redirects HERE (no client moment), so completeSignIn runs server-side
// (adopts + clears the guest cookie). A finalize failure/sessionless hit FAILS SAFE: keep the cookie, land on next?error=.
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

  // Mark a genuine post-auth arrival: ChatClient replays a queued draft ONLY on `?fromAuth=1`, so a stale draft never auto-sends.
  const dest = new URL(next, url.origin);
  dest.searchParams.set("fromAuth", "1");
  const res = NextResponse.redirect(dest);
  res.cookies.delete(GUEST_COOKIE); // drop the guest cookie on THIS response too (idempotent with completeSignIn)
  return res;
}
