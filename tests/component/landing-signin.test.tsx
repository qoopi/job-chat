// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// refresh #2 s10: the landing header reads the session server-side (resolveViewer) and seeds
// LandingSignIn. Guest -> "Sign in" (opens the lazy dialog, unchanged). Signed-in -> a primary "Open your
// chats" (-> the most recent conversation, else /chat/new) + the same account chip/menu as the chat title
// bar (Sign out lives INSIDE the menu now). Sign-out mirrors the sidebar (Better Auth signOut + rotate the
// guest cookie) but STAYS on the landing and flips the header to guest in place. Boundaries mocked.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: import("react").ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const openAuthDialogMock = vi.fn();
vi.mock("@/lib/auth-dialog", () => ({
  openAuthDialog: () => openAuthDialogMock(),
}));

const clearGuestSessionMock = vi.fn(async () => {});
vi.mock("@/app/actions", () => ({
  clearGuestSession: () => clearGuestSessionMock(),
}));

// signOut invokes fetchOptions.onSuccess on a successful request (Better Auth contract) - the same shape
// the sidebar sign-out relies on.
const signOutMock = vi.fn(
  async (opts?: { fetchOptions?: { onSuccess?: () => void } }) => {
    opts?.fetchOptions?.onSuccess?.();
  },
);
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signOut: (opts?: { fetchOptions?: { onSuccess?: () => void } }) =>
      signOutMock(opts),
  },
}));

import { LandingSignIn } from "@/components/landing/LandingSignIn";

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  openAuthDialogMock.mockClear();
  clearGuestSessionMock.mockClear();
  signOutMock.mockClear();
});

describe("landing header session-awareness (refresh #2 s10)", () => {
  test("Should_ShowSignIn_When_Guest", () => {
    render(<LandingSignIn signedIn={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(openAuthDialogMock).toHaveBeenCalledTimes(1); // opens the lazy dialog (unchanged guest path)
    expect(screen.queryByRole("link", { name: /Open your chats/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Account:/ })).toBeNull();
  });

  test("Should_ShowOpenYourChatsToMostRecent_AndAccountMenu_When_SignedIn", () => {
    render(
      <LandingSignIn
        signedIn
        accountName="Ada"
        openChatsHref="/chat/abc-123"
      />,
    );

    // primary CTA -> the most recent conversation
    expect(
      screen
        .getByRole("link", { name: "Open your chats" })
        .getAttribute("href"),
    ).toBe("/chat/abc-123");
    // the account chip; Sign out is inside its menu (not a top-level button)
    expect(screen.getByRole("button", { name: /Account: Ada/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull(); // menu closed
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  test("Should_StayOnLandingAndFlipToGuest_When_SignedOutFromTheMenu", async () => {
    render(
      <LandingSignIn
        signedIn
        accountName="Ada"
        openChatsHref="/chat/abc-123"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ })); // open the menu
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(clearGuestSessionMock).toHaveBeenCalledTimes(1); // guest cookie rotated (mirrors the sidebar)
    // flips to guest in place - stays on the landing (no navigation): Sign in is back, account gone.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Account:/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open your chats" })).toBeNull();
  });
});
