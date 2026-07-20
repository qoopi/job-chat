// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Conversation } from "@shared/store";

// next/link needs the app-router context, absent in a bare component render; a plain anchor is a faithful
// stand-in for the href + accessible-name assertions here.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: import("react").ReactNode }) => (
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
  { id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Top companies hiring", created_at: ago(2 * 3_600_000) },
  { id: "bbbbbbbb-0000-4000-8000-000000000002", title: "Data Engineer pay in SF", created_at: ago(2 * 86_400_000) },
];

afterEach(cleanup);

describe("signed-in history (AC-12)", () => {
  test("lists conversations in the given (newest-first) order with title + relative date, active highlighted", () => {
    const { container } = render(<Sidebar signedIn conversations={convs} activeId={convs[0].id} />);
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
    expect(screen.getByRole("link", { name: /Top companies hiring/ }).getAttribute("href")).toBe(
      `/chat/${convs[0].id}`,
    );
    expect(screen.getByRole("link", { name: /Data Engineer pay in SF/ }).getAttribute("href")).toBe(
      `/chat/${convs[1].id}`,
    );
  });

  test("New chat starts a fresh conversation", () => {
    render(<Sidebar signedIn conversations={convs} activeId={convs[0].id} />);
    expect(screen.getByRole("link", { name: "New chat" }).getAttribute("href")).toBe("/");
  });

  test("an empty account reads 'No conversations yet'", () => {
    render(<Sidebar signedIn conversations={[]} />);
    expect(screen.getByText("No conversations yet")).toBeTruthy();
    expect(document.querySelector(".sb-item")).toBeNull();
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
