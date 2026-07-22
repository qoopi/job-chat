// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Conversation } from "@shared/store";

// page.tsx's OWN logic: the "most recent conversation, else /chat/new" resolution and the optional
// welcome sub-line. Server Component (a plain async function with no hooks) - called directly and
// its returned element rendered, same approach as chat-page-resume-gate.test.ts.
const hadE2EFlag = "JOBCHAT_E2E" in process.env;
const priorE2EFlag = process.env.JOBCHAT_E2E;
process.env.JOBCHAT_E2E = ""; // force the production (resolveViewer) branch, not the E2E fixture path
afterAll(() => {
  if (hadE2EFlag) process.env.JOBCHAT_E2E = priorE2EFlag;
  else delete process.env.JOBCHAT_E2E;
});

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

const resolveViewerMock = vi.fn();
const listOwnerConversationsMock = vi.fn(async (accountUserId: string) => {
  void accountUserId; // typed only so the mock accepts the real signature's argument
  return [] as Pick<Conversation, "id" | "title" | "created_at">[];
});
vi.mock("@/lib/server-store", () => ({
  resolveViewer: () => resolveViewerMock(),
  listOwnerConversations: (id: string) => listOwnerConversationsMock(id),
}));

// LandingComposer pulls in the chat transport - irrelevant to the header logic under test here.
vi.mock("@/components/landing/LandingComposer", () => ({
  LandingComposer: () => <div data-testid="composer-stub" />,
}));

const landingSignInProps = vi.fn();
vi.mock("@/components/landing/LandingSignIn", () => ({
  LandingSignIn: (props: Record<string, unknown>) => {
    landingSignInProps(props);
    return <div data-testid="signin-stub" />;
  },
}));

import Landing from "@/app/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Landing session-aware header (refresh #2 s10)", () => {
  it("Should_TargetMostRecentConversation_When_SignedInWithHistory (AC-D36)", async () => {
    resolveViewerMock.mockResolvedValue({
      signedIn: true,
      accountUserId: "acct-1",
      accountName: "Ada",
      accountEmail: "ada@example.com",
    });
    listOwnerConversationsMock.mockResolvedValue([
      {
        id: "conv-recent",
        title: "Median salary in SF",
        created_at: new Date(),
      },
    ]);

    render(await Landing());

    expect(listOwnerConversationsMock).toHaveBeenCalledWith("acct-1");
    expect(landingSignInProps).toHaveBeenCalledWith(
      expect.objectContaining({
        openChatsHref: "/chat/conv-recent",
        signedIn: true,
      }),
    );
  });

  it("Should_TargetChatNew_When_SignedInWithNoConversations (AC-D36)", async () => {
    resolveViewerMock.mockResolvedValue({
      signedIn: true,
      accountUserId: "acct-1",
      accountName: "Ada",
    });
    listOwnerConversationsMock.mockResolvedValue([]);

    render(await Landing());

    expect(landingSignInProps).toHaveBeenCalledWith(
      expect.objectContaining({ openChatsHref: "/chat/new" }),
    );
  });

  it("Should_TargetChatNew_AndNotQueryHistory_When_Guest (AC-D36/AC-D39 regression)", async () => {
    resolveViewerMock.mockResolvedValue({ signedIn: false });

    render(await Landing());

    expect(listOwnerConversationsMock).not.toHaveBeenCalled();
    expect(landingSignInProps).toHaveBeenCalledWith(
      expect.objectContaining({ openChatsHref: "/chat/new", signedIn: false }),
    );
  });

  it("Should_ShowWelcomeSubline_When_SignedInWithLastConversation (AC-D38)", async () => {
    resolveViewerMock.mockResolvedValue({
      signedIn: true,
      accountUserId: "acct-1",
      accountName: "Ada Lovelace",
    });
    listOwnerConversationsMock.mockResolvedValue([
      {
        id: "conv-recent",
        title: "Median salary in SF",
        created_at: new Date(),
      },
    ]);

    render(await Landing());

    expect(screen.getByText(/Welcome back, Ada/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Median salary in SF/ })
        .getAttribute("href"),
    ).toBe("/chat/conv-recent");
  });

  it("Should_NotShowWelcomeSubline_When_Guest (AC-D38)", async () => {
    resolveViewerMock.mockResolvedValue({ signedIn: false });

    render(await Landing());

    expect(screen.queryByText(/Welcome back/)).toBeNull();
  });

  it("Should_NotShowWelcomeSubline_When_SignedInWithNoConversations (AC-D38)", async () => {
    resolveViewerMock.mockResolvedValue({
      signedIn: true,
      accountUserId: "acct-1",
      accountName: "Ada",
    });
    listOwnerConversationsMock.mockResolvedValue([]);

    render(await Landing());

    expect(screen.queryByText(/Welcome back/)).toBeNull();
  });
});
