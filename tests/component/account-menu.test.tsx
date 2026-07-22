// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AccountMenu } from "@/components/chat/AccountMenu";
import { TitleBar } from "@/components/chat/TitleBar";
import { setAuthDialogOpen } from "@/lib/layers";

// The signed-in auth affordance lives in the title bar - an account chip that opens a
// menu (email header, Your profile, Dark-mode toggle, Sign out). The guest sees an obvious Sign in
// button instead. The dark-mode toggle persists via the `theme` cookie (works guest + signed-in).
const pressEsc = () =>
  act(
    () =>
      void window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" }),
      ),
  );

afterEach(() => {
  cleanup();
  setAuthDialogOpen(false);
  document.documentElement.removeAttribute("data-theme");
  document.cookie = "theme=; path=/; max-age=0";
});

describe("AccountMenu", () => {
  test("the chip opens the menu: email + Personal account header, Your profile, Dark mode, Sign out", () => {
    render(
      <AccountMenu
        accountName="Ada Lovelace"
        email="ada@example.com"
        onOpenProfile={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    const chip = screen.getByRole("button", { name: /Account: Ada Lovelace/ });
    expect(chip.textContent).toContain("Ada"); // the chip shows the FIRST name
    expect(screen.queryByText("Personal account")).toBeNull(); // closed initially

    fireEvent.click(chip);
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Personal account")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Your profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Dark mode/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  test("'Your profile' fires onOpenProfile and closes the menu", () => {
    const onOpenProfile = vi.fn();
    render(
      <AccountMenu
        accountName="Ada"
        onOpenProfile={onOpenProfile}
        onSignOut={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));
    expect(onOpenProfile).toHaveBeenCalledOnce();
    expect(screen.queryByText("Personal account")).toBeNull();
  });

  test("'Sign out' fires onSignOut", () => {
    const onSignOut = vi.fn();
    render(
      <AccountMenu
        accountName="Ada"
        onOpenProfile={vi.fn()}
        onSignOut={onSignOut}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  test("the Dark-mode toggle flips <html data-theme> + its pressed state, and persists via the theme cookie", () => {
    render(
      <AccountMenu
        accountName="Ada"
        onOpenProfile={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ }));
    const toggle = screen.getByRole("button", { name: /Dark mode/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("Dark");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.cookie).toContain("theme=dark"); // the server reads this next render (no FOUC)

    fireEvent.click(toggle); // toggling back
    expect(document.documentElement.getAttribute("data-theme")).toBe("Light");
    expect(document.cookie).toContain("theme=light");
  });

  test("closes on Escape and on an outside click", () => {
    render(
      <AccountMenu
        accountName="Ada"
        onOpenProfile={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    const chip = screen.getByRole("button", { name: /Account: Ada/ });

    fireEvent.click(chip);
    expect(screen.getByText("Personal account")).toBeTruthy();
    pressEsc();
    expect(screen.queryByText("Personal account")).toBeNull();

    fireEvent.click(chip);
    expect(screen.getByText("Personal account")).toBeTruthy();
    fireEvent.mouseDown(document.body); // outside click
    expect(screen.queryByText("Personal account")).toBeNull();
  });

  test("yields Escape while the auth dialog is open (below it in layer priority)", () => {
    render(
      <AccountMenu
        accountName="Ada"
        onOpenProfile={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ }));
    setAuthDialogOpen(true); // the dialog above consumes Esc first
    pressEsc();
    expect(screen.getByText("Personal account")).toBeTruthy(); // menu stays open
  });
});

describe("TitleBar right slot", () => {
  test("guest: an obvious Sign in button (no account chip)", () => {
    const onSignIn = vi.fn();
    render(
      <TitleBar title="Median salary" signedIn={false} onSignIn={onSignIn} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Account:/ })).toBeNull();
    // the title text is still assertable on its own (the right slot is a sibling)
    expect(screen.getByTestId("title-bar").textContent).toBe("Median salary");
  });

  test("signed-in: the account chip, not a Sign in button", () => {
    render(
      <TitleBar
        title="Median salary"
        signedIn
        accountName="Ada"
        email="ada@example.com"
        onOpenProfile={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Account: Ada/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByTestId("title-bar").textContent).toBe("Median salary");
  });
});
