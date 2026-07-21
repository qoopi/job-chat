// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Conversation } from "@shared/store";

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

// AC-12 (UI slice): the signed-in sidebar is a real history - newest first, title + relative date,
// active highlight on the current route, each row loads its conversation, New chat starts a fresh one,
// and an empty account reads "No conversations yet". Guests keep the teaser + Sign in (unchanged). The
// order itself is 012's store test; here we assert the sidebar renders what it is given, in order.

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

afterEach(cleanup);

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

  // AC-19: New chat starts fresh IN PLACE - it is a button that calls onNewChat, NOT a link that bounces
  // to the landing (the old signed-in `<Link href="/">` was the conformance bug).
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

  // refresh #2 s5: each row gains a muted first-message preview between the title and the date, so two
  // conversations that share a title are still distinguishable.
  test("rows render a first-message preview line that distinguishes duplicate titles", () => {
    const dupTitles = [
      {
        id: convs[0].id,
        title: "Median salary in SF",
        created_at: ago(3_600_000),
        preview: "median salary for a data engineer in SF",
      },
      {
        id: convs[1].id,
        title: "Median salary in SF",
        created_at: ago(7_200_000),
        preview: "and what about staff-level roles?",
      },
    ];
    const { container } = render(
      <Sidebar signedIn conversations={dupTitles} activeId={convs[0].id} />,
    );
    const previews = Array.from(container.querySelectorAll(".sb-preview")).map(
      (n) => n.textContent,
    );
    expect(previews).toEqual([
      "median salary for a data engineer in SF",
      "and what about staff-level roles?",
    ]);
  });
});

// refresh #2 s5: identity/auth moved to the title bar, so the sidebar foot (avatar + Sign in/Sign out
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

  // AC-D20 is explicit ("neither guest nor signed-in") - the above only covered signed-in.
  test("no sb-foot in the guest render either", () => {
    const { container } = render(<Sidebar signedIn={false} />);
    expect(container.querySelector(".sb-foot")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  // Corrected premise (task 019, s6 delta): "the collapsed-rail avatar goes with the foot - it does, per
  // 'identity only in the TitleBar'". Collapse the sidebar and check the rail for a leftover avatar chip
  // in both auth states.
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

// AC-20: the wordmark is a way home.
describe("logo (AC-20)", () => {
  test("the jobchat.dev wordmark links to the landing", () => {
    render(<Sidebar signedIn conversations={convs} activeId={convs[0].id} />);
    expect(
      screen.getByRole("link", { name: /jobchat\.dev/i }).getAttribute("href"),
    ).toBe("/");
  });
});

// AC-21: signed-in rows carry a delete affordance behind an inline confirm (never a modal); guests get none.
describe("delete conversation (AC-21)", () => {
  test("a signed-in row deletes via an inline confirm - onDeleteConversation fires only on confirm", () => {
    const onDeleteConversation = vi.fn();
    render(
      <Sidebar
        signedIn
        conversations={convs}
        activeId={convs[0].id}
        onDeleteConversation={onDeleteConversation}
      />,
    );

    // The affordance opens an inline confirm - not a modal, and nothing deletes yet. The accessible
    // name carries a short id suffix (disambiguates same-titled rows), so match on the title prefix.
    fireEvent.click(
      screen.getByRole("button", { name: /^Delete Top companies hiring/ }),
    );
    expect(screen.getByText("Delete this chat?")).toBeTruthy();
    expect(onDeleteConversation).not.toHaveBeenCalled();

    // Cancel backs out with no delete.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete this chat?")).toBeNull();
    expect(onDeleteConversation).not.toHaveBeenCalled();

    // Re-open and confirm -> the delete fires with the row's id.
    fireEvent.click(
      screen.getByRole("button", { name: /^Delete Top companies hiring/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteConversation).toHaveBeenCalledWith(convs[0].id);
  });

  test("a guest sidebar has no delete affordance", () => {
    render(<Sidebar signedIn={false} />);
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
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
