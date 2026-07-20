import { NextResponse } from "next/server";
import { completeSignIn } from "@/app/actions";

// The name of the unsigned guest bearer cookie (mirrors actions.ts / server-store.ts - a "use server"
// module cannot export a non-async const, so it is repeated here as those modules already do).
const GUEST_COOKIE = "jobchat_guest";

// Only ever redirect to a same-origin PATH (a single leading slash, not "//" protocol-relative and not an
// absolute URL) - an attacker-supplied `next` must never become an open redirect. Fall back to the landing.
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

// The Google OAuth success landing (the STABLE callbackURL that AuthDialog hands Better Auth). Better
// Auth's /api/auth/callback/google sets the session cookie then full-page-redirects HERE - there is no
// client moment to run the sign-in TRANSITION, so we run it server-side: completeSignIn adopts the
// guest's conversations onto the account and clears the guest cookie (the SAME transition the removed
// email path used). Then land the now-signed-in user back where they started (`next`). A finalize
// failure keeps the guest cookie and lands on `next?error=` so the dialog surfaces it - never a silent
// reload. `next` is confined to a same-origin path (open-redirect guard).
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));

  try {
    await completeSignIn();
  } catch {
    // Adoption failed: do NOT clear the guest cookie (the per-request path still needs it). Surface it.
    const dest = new URL(next, url.origin);
    dest.searchParams.set("error", "signin_incomplete");
    return NextResponse.redirect(dest);
  }

  const res = NextResponse.redirect(new URL(next, url.origin));
  // Belt-and-suspenders: guarantee the guest cookie is dropped on THIS redirect response, regardless of
  // how Next merges completeSignIn's next/headers cookie mutation (idempotent with it).
  res.cookies.delete(GUEST_COOKIE);
  return res;
}
