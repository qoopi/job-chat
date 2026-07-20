import { afterEach, describe, expect, it, vi } from "vitest";

// 017 strand 2: the Google OAuth success landing. Better Auth's /api/auth/callback/google sets the
// session cookie then full-page-redirects to /auth/complete - the route runs the sign-in TRANSITION
// server-side (adopt the guest's conversations + clear the guest cookie via completeSignIn) and lands
// the user back where they started (`next`). A finalize failure keeps the guest cookie and lands on
// `next?error=` so the dialog surfaces it. `completeSignIn` (the only side-effect boundary) is mocked;
// the route's own redirect + cookie + open-redirect guard are under test.
const completeSignInMock = vi.fn(async () => ({ ok: true, name: "Ada" }));
vi.mock("@/app/actions", () => ({ completeSignIn: () => completeSignInMock() }));

import { GET } from "@/app/auth/complete/route";

const req = (path: string) => new Request(`http://localhost:3000${path}`);

afterEach(() => vi.clearAllMocks());

describe("/auth/complete Google callback finalize", () => {
  it("Should_FinalizeAndLandOnNext_When_SignedIn", async () => {
    const res = await GET(req("/auth/complete?next=%2Fchat%2Fabc"));

    expect(completeSignInMock).toHaveBeenCalledTimes(1); // adoption + guest-cookie clear ran
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/chat/abc");
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
      expect(res.headers.get("location")).toBe("http://localhost:3000/");
    }
  });

  it("Should_FallBackToLanding_When_NextMissing", async () => {
    const res = await GET(req("/auth/complete"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });
});
