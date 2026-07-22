import { afterEach, describe, expect, it, vi } from "vitest";

// The Google OAuth success landing. Better Auth's /api/auth/callback/google sets the
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
    // A genuine post-auth arrival is marked so ChatClient may replay a queued draft
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

  // WHATWG URL parsing normalizes a backslash to "/" for special schemes (http/https) and strips
  // ASCII tab/CR/LF BEFORE that normalization - so a value that passes a bare string-prefix check
  // (`startsWith("/") && !startsWith("//")`) can still resolve to a foreign origin:
  //   new URL("/\\evil.com", "http://localhost:3000").host   -> "evil.com"
  //   new URL("/\\/evil.com", "http://localhost:3000").host  -> "evil.com"
  //   new URL("/\t/evil.com", "http://localhost:3000").host  -> "evil.com"
  // safeNext must resolve FIRST, then compare origins; these smuggled values must land on the landing.
  it("Should_FallBackToLanding_When_NextIsBackslashOrControlCharSmuggled", async () => {
    const adversarial = [
      "/\\evil.com", // one literal backslash - normalizes to "//evil.com" (protocol-relative) for http(s)
      "/\\/evil.com", // backslash then slash - same normalization
      "/\t/evil.com", // a literal tab (as decoded from a query-string %09) - stripped, then "//evil.com"
    ];
    for (const bad of adversarial) {
      const res = await GET(req(`/auth/complete?next=${encodeURIComponent(bad)}`));
      const loc = new URL(res.headers.get("location")!);
      expect(loc.host).toBe("localhost:3000"); // MUST stay same-origin
    }
  });

  // completeSignIn returns `{ ok: false }` WITHOUT throwing when there is no verified session (a direct
  // GET or a replayed `/auth/complete` link with no Google round trip). The route must branch on `ok`,
  // not just throw-vs-no-throw: fail safe - keep the guest cookie and land on `next?error=` - never a
  // success-shaped redirect that silently resets a guest whose session was never adopted or recognized.
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
