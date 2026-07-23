// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Conversation } from "@shared/store";
import { setAuthDialogOpen, setMenuOpen } from "@/lib/layers";

// next/link needs the app-router context, absent in a bare component render; a plain anchor is a faithful
// stand-in for the href + accessible-name assertions here.
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

import { Sidebar } from "@/components/chat/Sidebar";

// The signed-in sidebar is a real history - newest first, title + relative date,
// active highlight on the current route, each row loads its conversation, New chat starts a fresh one,
// and an empty account reads "No conversations yet". Guests keep the teaser + Sign in (unchanged). The
// order itself is the store's own test; here we assert the sidebar renders what it is given, in order.

const ago = (ms: number) => new Date(Date.now() - ms);
const convs: Pick<Conversation, "id" | "title" | "created_at">[] = [
  {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    title: "Top companies hiring",
    created_at: ago(2 * 3_600_000),
  },
  {
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    title: "Data Engineer pay in SF",
    created_at: ago(2 * 86_400_000),
  },
];

const pressEsc = () =>
  act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

afterEach(() => {
  cleanup();
  setAuthDialogOpen(false);
  setMenuOpen(false); // the sidebar publishes its kebab-menu state to this module singleton
});

describe("signed-in history (AC-12)", () => {
  test("lists conversations in the given (newest-first) order with title + relative date, active highlighted", () => {
    const { container } = render(
      <Sidebar signedIn conversations={convs} activeId={convs[0].id} />,
    );
    const items = Array.from(container.querySelectorAll(".sb-item"));
    expect(items).toHaveLength(2);

    // order preserved (newest first as supplied)
    expect(items[0].textContent).toContain("Top companies hiring");
    expect(items[1].textContent).toContain("Data Engineer pay in SF");
    // relative dates rendered off created_at
    expect(items[0].querySelector("time")?.textContent).toBe("2h ago");
    expect(items[1].querySelector("time")?.textContent).toBe("2d ago");
    // active highlight keys on the route param
    expect(items[0].classList.contains("active")).toBe(true);
    expect(items[1].classList.contains("active")).toBe(false);
  });

  test("each row is a link that loads its conversation route (click loads)", () => {
    render(<Sidebar signedIn conversations={convs} activeId={convs[0].id} />);
    expect(
      screen
        .getByRole("link", { name: /Top companies hiring/ })
        .getAttribute("href"),
    ).toBe(`/chat/${convs[0].id}`);
    expect(
      screen
        .getByRole("link", { name: /Data Engineer pay in SF/ })
        .getAttribute("href"),
    ).toBe(`/chat/${convs[1].id}`);
  });

  // New chat starts fresh IN PLACE - it is a button that calls onNewChat, NOT a link that bounces
  // to the landing.
  test("New chat is an in-place button, not a landing link (AC-19)", () => {
    const onNewChat = vi.fn();
    render(
      <Sidebar
        signedIn
        conversations={convs}
        activeId={convs[0].id}
        onNewChat={onNewChat}
      />,
    );
    expect(screen.queryByRole("link", { name: "New chat" })).toBeNull(); // no bounce to "/"
    const btn = screen.getByRole("button", { name: "New chat" });
    fireEvent.click(btn);
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  test("an empty account reads 'No conversations yet'", () => {
    render(<Sidebar signedIn conversations={[]} />);
    expect(screen.getByText("No conversations yet")).toBeTruthy();
    expect(document.querySelector(".sb-item")).toBeNull();
  });

  // 036 design contract (interaction-spec s5): a row is title + relative date only - the preview layer
  // (which duplicated the title on every row, since title == first user message == preview) is removed.
  test("duplicate titles render title + date only, with NO preview line", () => {
    const dupTitles = [
      { id: convs[0].id, title: "Median salary in SF", created_at: ago(3_600_000) },
      { id: convs[1].id, title: "Median salary in SF", created_at: ago(7_200_000) },
    ];
    const { container } = render(
      <Sidebar signedIn conversations={dupTitles} activeId={convs[0].id} />,
    );
    expect(container.querySelectorAll(".sb-preview")).toHaveLength(0); // the preview layer is gone
    const items = Array.from(container.querySelectorAll(".sb-item"));
    expect(items).toHaveLength(2);
    items.forEach((item) => {
      expect(item.querySelector(".sb-title")?.textContent).toBe("Median salary in SF");
      expect(item.querySelector("time")).toBeTruthy();
    });
  });

  // 036 empty-pill: a legacy/edge empty-or-whitespace title must never render as a bare pill (a padded row
  // with only a faint date). Render-side second-layer guard - the source (deriveTitle) already maps empty -> "New chat".
  test("an empty/whitespace title never renders as an empty pill (falls back to a label)", () => {
    const badRows = [
      { id: convs[0].id, title: "", created_at: ago(3_600_000) },
      { id: convs[1].id, title: "   ", created_at: ago(7_200_000) },
    ];
    const { container } = render(
      <Sidebar signedIn conversations={badRows} activeId={convs[0].id} />,
    );
    const titles = Array.from(container.querySelectorAll(".sb-item .sb-title"));
    expect(titles).toHaveLength(2);
    titles.forEach((t) => expect((t.textContent ?? "").trim().length).toBeGreaterThan(0));
  });
});

// Identity/auth moved to the title bar, so the sidebar foot (avatar + Sign in/Sign out
// links) is gone in BOTH states.
describe("sidebar foot removed (refresh #2 s5)", () => {
  test("no sb-foot, and no Sign out anywhere in the sidebar", () => {
    const { container } = render(
      <Sidebar
        signedIn
        conversations={convs}
        activeId={convs[0].id}
      />,
    );
    expect(container.querySelector(".sb-foot")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  // The rule is "neither guest nor signed-in" - the test above only covered signed-in.
  test("no sb-foot in the guest render either", () => {
    const { container } = render(<Sidebar signedIn={false} />);
    expect(container.querySelector(".sb-foot")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  // The collapsed-rail avatar goes with the foot - it does, per 'identity only in the TitleBar'.
  // Collapse the sidebar and check the rail for a leftover avatar chip in both auth states.
  test("the collapsed rail has no avatar (identity lives only in the TitleBar) - signed-in", () => {
    const { container } = render(
      <Sidebar
        signedIn
        conversations={convs}
        activeId={convs[0].id}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(container.querySelector(".avatar")).toBeNull();
  });

  test("the collapsed rail has no avatar - guest", () => {
    const { container } = render(<Sidebar signedIn={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(container.querySelector(".avatar")).toBeNull();
  });
});

// The wordmark is a way home.
describe("logo (AC-20)", () => {
  test("the jobchat.dev wordmark links to the landing", () => {
    render(<Sidebar signedIn conversations={convs} activeId={convs[0].id} />);
    expect(
      screen.getByRole("link", { name: /jobchat\.dev/i }).getAttribute("href"),
    ).toBe("/");
  });
});

// Signed-in rows carry a kebab (three-dots) menu with Rename + Delete (039); Delete keeps the existing
// inline confirm (never a modal); guests get no kebab.
const openKebab = (titlePrefix: string) =>
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`^Options for ${titlePrefix}`) }),
  );

describe("kebab menu (039)", () => {
  test("the kebab opens a Rename/Delete menu; one open at a time; outside-click and Esc close it", () => {
    render(
      <Sidebar
        signedIn
        conversations={convs}
        activeId={convs[0].id}
        onDeleteConversation={vi.fn()}
        onRenameConversation={vi.fn()}
      />,
    );
    const kebabA = screen.getByRole("button", { name: /^Options for Top companies hiring/ });
    const kebabB = screen.getByRole("button", { name: /^Options for Data Engineer pay in SF/ });

    expect(screen.queryByRole("menuitem")).toBeNull(); // closed initially
    fireEvent.click(kebabA);
    expect(kebabA.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();

    // Opening B closes A - only one menu at a time.
    fireEvent.click(kebabB);
    expect(kebabA.getAttribute("aria-expanded")).toBe("false");
    expect(kebabB.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem", { name: "Rename" })).toHaveLength(1);

    // Outside-click closes.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menuitem")).toBeNull();

    // Esc closes too, but yields while the auth dialog is above it (layer priority).
    fireEvent.click(kebabA);
    setAuthDialogOpen(true);
    pressEsc();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy(); // yielded
    setAuthDialogOpen(false);
    pressEsc();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  test("Rename opens an inline input seeded with the title; Enter saves the trimmed value, Esc cancels", () => {
    const onRenameConversation = vi.fn();
    render(
      <Sidebar
        signedIn
        conversations={convs}
        activeId={convs[0].id}
        onRenameConversation={onRenameConversation}
      />,
    );

    openKebab("Top companies hiring");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /Rename Top companies hiring/ }) as HTMLInputElement;
    expect(input.value).toBe("Top companies hiring"); // seeded with the current title

    // Esc cancels: no save, input gone.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRenameConversation).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();

    // Re-open, edit, Enter saves the trimmed title.
    openKebab("Top companies hiring");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input2 = screen.getByRole("textbox", { name: /Rename Top companies hiring/ }) as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "  Hiring leaders  " } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(onRenameConversation).toHaveBeenCalledWith(convs[0].id, "Hiring leaders");
  });

  test("Delete from the kebab opens the inline confirm - onDeleteConversation fires only on confirm", () => {
    const onDeleteConversation = vi.fn();
    render(
      <Sidebar
        signedIn
        conversations={convs}
        activeId={convs[0].id}
        onDeleteConversation={onDeleteConversation}
      />,
    );

    openKebab("Top companies hiring");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText("Delete this chat?")).toBeTruthy(); // inline, not a modal
    expect(onDeleteConversation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete this chat?")).toBeNull();
    expect(onDeleteConversation).not.toHaveBeenCalled();

    openKebab("Top companies hiring");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteConversation).toHaveBeenCalledWith(convs[0].id);
  });

  test("a guest sidebar has no kebab affordance", () => {
    render(<Sidebar signedIn={false} />);
    expect(screen.queryByRole("button", { name: /^Options for / })).toBeNull();
  });
});

describe("guest sidebar (unchanged)", () => {
  test("shows the teaser + Sign in, and Sign in opens the auth dialog", () => {
    const onSignIn = vi.fn();
    render(<Sidebar signedIn={false} onSignIn={onSignIn} />);
    expect(screen.getByText(/keep your conversations/i)).toBeTruthy();
    const signIns = screen.getAllByRole("button", { name: "Sign in" });
    expect(signIns.length).toBeGreaterThan(0);
    fireEvent.click(signIns[0]);
    expect(onSignIn).toHaveBeenCalled();
    // no history rows for a guest
    expect(document.querySelector(".sb-item.active")).toBeNull();
  });
});
