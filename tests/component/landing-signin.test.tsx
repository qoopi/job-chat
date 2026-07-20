// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 017 fix round 2 (must-fix 2): the landing header reads the session server-side (resolveViewer) and
// seeds LandingSignIn. Guest -> "Sign in" (opens the lazy dialog, unchanged). Signed-in -> account name +
// "Open chat" (into /chat/new) + Sign out. Sign-out mirrors the sidebar (Better Auth signOut + rotate the
// guest cookie) but STAYS on the landing and flips the header to guest in place (no navigation). External
// boundaries mocked; the component's own state flip + wiring are under test.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: import("react").ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const openAuthDialogMock = vi.fn();
vi.mock("@/lib/auth-dialog", () => ({ openAuthDialog: () => openAuthDialogMock() }));

const clearGuestSessionMock = vi.fn(async () => {});
vi.mock("@/app/actions", () => ({ clearGuestSession: () => clearGuestSessionMock() }));

// signOut invokes fetchOptions.onSuccess on a successful request (Better Auth contract) - the same shape
// the sidebar sign-out relies on.
const signOutMock = vi.fn(async (opts?: { fetchOptions?: { onSuccess?: () => void } }) => {
  opts?.fetchOptions?.onSuccess?.();
});
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: (opts?: { fetchOptions?: { onSuccess?: () => void } }) => signOutMock(opts) },
}));

import { LandingSignIn } from "@/components/landing/LandingSignIn";

afterEach(() => {
  cleanup();
  openAuthDialogMock.mockClear();
  clearGuestSessionMock.mockClear();
  signOutMock.mockClear();
});

describe("landing header session-awareness (017 fix round 2)", () => {
  test("Should_ShowSignIn_When_Guest", () => {
    render(<LandingSignIn signedIn={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(openAuthDialogMock).toHaveBeenCalledTimes(1); // opens the lazy dialog (unchanged guest path)
    expect(screen.queryByRole("link", { name: "Open chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  test("Should_ShowAccountOpenChatAndSignOut_When_SignedIn", () => {
    render(<LandingSignIn signedIn accountName="Ada" />);

    expect(screen.getByText("Ada")).toBeTruthy(); // account name
    expect(screen.getByRole("link", { name: "Open chat" }).getAttribute("href")).toBe("/chat/new"); // into the app
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  test("Should_StayOnLandingAndFlipToGuest_When_SignedOut", async () => {
    render(<LandingSignIn signedIn accountName="Ada" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(clearGuestSessionMock).toHaveBeenCalledTimes(1); // guest cookie rotated (mirrors the sidebar)
    // flips to guest in place - stays on the landing (no navigation): the header now offers Sign in again,
    // and the signed-in affordances are gone.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
