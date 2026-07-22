// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UIMessage } from "ai";
import type { Conversation } from "@shared/store";
import { closeAuthDialog } from "@/lib/auth-dialog";

// Sign out must land the user on the landing as a GUEST with no stale thread. onSignOut
// drops the Better Auth session, clears the guest cookie (rotate), clears the open thread + sidebar
// history, and redirects to "/". External boundaries mocked; ChatClient's own sign-out wiring is tested.
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream({ start: (c) => c.close() }),
);
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
  }),
}));

const clearGuestSessionMock = vi.fn(async () => {});
vi.mock("@/app/actions", () => ({
  sendMessage: vi.fn(),
  mintChatToken: vi.fn(),
  deleteConversation: vi.fn(),
  startConversation: vi.fn(),
  clearGuestSession: () => clearGuestSessionMock(),
}));

// signOut invokes fetchOptions.onSuccess on a successful request (Better Auth contract).
const signOutMock = vi.fn(
  async (opts?: { fetchOptions?: { onSuccess?: () => void } }) => {
    opts?.fetchOptions?.onSuccess?.();
  },
);
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { social: vi.fn() },
    signOut: (opts?: { fetchOptions?: { onSuccess?: () => void } }) =>
      signOutMock(opts),
    useSession: () => ({ data: null, isPending: false }),
  },
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
// The thread body is a UNIQUE marker (distinct from the title / sidebar text) so a single getByText
// resolves the message bubble alone.
const initialMessages: UIMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "unique-thread-body" }],
  },
];
const conversations: Pick<Conversation, "id" | "title" | "created_at">[] = [
  { id: CONVERSATION_ID, title: "Old thread", created_at: new Date() },
];

afterEach(() => {
  cleanup();
  closeAuthDialog();
  signOutMock.mockClear();
  clearGuestSessionMock.mockClear();
  pushMock.mockClear();
});

describe("sign-out lands on the landing as a guest (017 strand 3)", () => {
  test("Should_RedirectToLanding_AndClearGuestAndThread_When_SignedOut", async () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        title="Old thread"
        initialMessages={initialMessages}
        e2e={false}
        signedIn
        accountName="Ada"
        conversations={conversations}
      />,
    );

    // signed-in: the thread is present, and Sign out lives in the title-bar account menu
    expect(screen.getByText("unique-thread-body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ })); // open the account menu
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    // redirected to the landing
    expect(pushMock).toHaveBeenCalledWith("/");
    // guest cookie rotated (defensive drop)
    expect(clearGuestSessionMock).toHaveBeenCalledTimes(1);
    // back to guest state: the sidebar foot offers Sign in, the account name is gone
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Sign in" }).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByText("Ada")).toBeNull(); // no stale account name lingers in the signed-out foot
    // no stale thread lingers after sign-out
    expect(screen.queryByText("unique-thread-body")).toBeNull();
  });
});
