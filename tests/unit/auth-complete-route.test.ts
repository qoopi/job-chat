import { afterEach, describe, expect, it, vi } from "vitest";

// 017 strand 2: the Google OAuth success landing. Better Auth's /api/auth/callback/google sets the
// session cookie then full-page-redirects to /auth/complete - the route runs the sign-in TRANSITION
// server-side (adopt the guest's conversations + clear the guest cookie via completeSignIn) and lands
// the user back where they started (`next`). A finalize failure keeps the guest cookie and lands on
// `next?error=` so the dialog surfaces it. `completeSignIn` (the only side-effect boundary) is mocked;
// the route's own redirect + cookie + open-redirect guard are under test.
const completeSignInMock = vi.fn(async (): Promise<{ ok: boolean; name?: string }> => ({ ok: true, name: "Ada" }));
vi.mock("@/app/actions", () => ({ completeSignIn: () => completeSignInMock() }));

import { GET } from "@/app/auth/complete/route";

const req = (path: string) => new Request(`http://localhost:3000${path}`);

afterEach(() => vi.clearAllMocks());

describe("/auth/complete Google callback finalize", () => {
  it("Should_FinalizeAndLandOnNext_When_SignedIn", async () => {
    const res = await GET(req("/auth/complete?next=%2Fchat%2Fabc"));

    expect(completeSignInMock).toHaveBeenCalledTimes(1); // adoption + guest-cookie clear ran
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/chat/abc");
    // fix round (item 2): a genuine post-auth arrival is marked so ChatClient may replay a queued draft
    expect(loc.searchParams.get("fromAuth")).toBe("1");
    // the guest cookie is dropped on the redirect response (session recognized -> guest id retired)
    expect(res.headers.get("set-cookie")).toMatch(/jobchat_guest=;/);
  });

  it("Should_LandOnNextWithError_When_FinalizeFails", async () => {
    completeSignInMock.mockRejectedValueOnce(new Error("adoption store failure"));

    const res = await GET(req("/auth/complete?next=%2Fchat%2Fabc"));

    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/chat/abc");
    expect(loc.searchParams.get("error")).toBe("signin_incomplete");
    // adoption failed: the guest cookie MUST survive so the per-request path still resolves the guest
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/jobchat_guest=;/);
  });

  it("Should_FallBackToLanding_When_NextIsOpenRedirect", async () => {
    for (const bad of ["//evil.com", "https://evil.com", "http://evil.com/x"]) {
      const res = await GET(req(`/auth/complete?next=${encodeURIComponent(bad)}`));
      const loc = new URL(res.headers.get("location")!);
      expect(loc.host).toBe("localhost:3000"); // never a foreign origin
      expect(loc.pathname).toBe("/"); // fell back to the landing (marker is inert there)
    }
  });

  it("Should_FallBackToLanding_When_NextMissing", async () => {
    const res = await GET(req("/auth/complete"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("localhost:3000");
    expect(loc.pathname).toBe("/");
  });

  // AUDIT (05-testing, independent pass): safeNext()'s guard is a string-prefix check
  // (`startsWith("/") && !startsWith("//")`), but the redirect is built with `new URL(next, origin)`.
  // WHATWG URL parsing normalizes a backslash to "/" for special schemes (http/https) and strips
  // ASCII tab/CR/LF BEFORE that normalization - so a value that passes the prefix check can still
  // resolve to a foreign origin. Confirmed with a standalone Node repro (not just this suite):
  //   new URL("/\\evil.com", "http://localhost:3000").host   -> "evil.com"
  //   new URL("/\\/evil.com", "http://localhost:3000").host  -> "evil.com"
  //   new URL("/\t/evil.com", "http://localhost:3000").host  -> "evil.com"
  // This is a PRODUCTION BUG in src/app/auth/complete/route.ts (safeNext), not a test gap - see the
  // Test Report's "Production bugs found". Left failing deliberately: do not patch product code here.
  it("Should_FallBackToLanding_When_NextIsBackslashOrControlCharSmuggled", async () => {
    const adversarial = [
      "/\\evil.com", // one literal backslash - normalizes to "//evil.com" (protocol-relative) for http(s)
      "/\\/evil.com", // backslash then slash - same normalization
      "/\t/evil.com", // a literal tab (as decoded from a query-string %09) - stripped, then "//evil.com"
    ];
    for (const bad of adversarial) {
      const res = await GET(req(`/auth/complete?next=${encodeURIComponent(bad)}`));
      const loc = new URL(res.headers.get("location")!);
      expect(loc.host).toBe("localhost:3000"); // MUST stay same-origin - currently resolves to evil.com
    }
  });

  // AUDIT (05-testing): the route discards `completeSignIn()`'s `{ ok }` result entirely - it only
  // branches on THROW vs no-throw. `completeSignIn` itself correctly returns `{ ok: false }` (no throw)
  // when there is no verified session (see complete-sign-in.test.ts
  // Should_NotClearCookieOrThrow_When_NoVerifiedSession), e.g. a direct GET or a replayed
  // `/auth/complete` link with no Google round trip. Because the route ignores `ok`, it still runs the
  // "success" branch: clears the guest cookie AND redirects to `next` with NO `?error=` - a guest's
  // session is silently reset with a success-shaped redirect even though nothing was ever adopted or
  // recognized. This is a PRODUCTION BUG (fails the "must not adopt/clear anything, must fail safe"
  // requirement), not a test gap - see the Test Report. Left failing deliberately.
  it("Should_NotClearGuestCookieOrLandOnSuccess_When_NoSessionExists", async () => {
    completeSignInMock.mockResolvedValueOnce({ ok: false }); // completeSignIn's real no-session return

    const res = await GET(req("/auth/complete?next=%2Fchat%2Fabc"));

    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/jobchat_guest=;/); // must not clear
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).not.toBeNull(); // must not look like a silent success
  });

  it("Should_BeIdempotent_When_HitTwiceWithAnActiveSession", async () => {
    // A replay (double-click, back button, retried request) while the session is still valid must not
    // throw, error, or diverge in outcome between the two hits - both land signed-in with no residue.
    const first = await GET(req("/auth/complete?next=%2Fchat%2Fabc"));
    const second = await GET(req("/auth/complete?next=%2Fchat%2Fabc"));

    expect(completeSignInMock).toHaveBeenCalledTimes(2);
    for (const res of [first, second]) {
      expect(res.status).toBe(307);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/chat/abc");
      expect(loc.searchParams.get("fromAuth")).toBe("1");
      expect(res.headers.get("set-cookie")).toMatch(/jobchat_guest=;/);
    }
  });
});
