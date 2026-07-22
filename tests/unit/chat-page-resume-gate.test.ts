import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message } from "@shared/store";
import type { Viewer } from "@/lib/server-store";

// Audit focus (013 testing pass): the resume-ownership gate in chat/[id]/page.tsx now reads
// `viewer.ownerIds.includes(loaded.conversation.user_id)` (ruling 2) instead of a bare guest-cookie
// compare. This is a Server Component - a plain async function - so it is called directly here (no
// render, no DOM) with its two collaborators (`@/lib/server-store`, ChatClient) mocked as the boundary.
// Proves the fail-closed property: a non-owner never sees another caller's thread, regardless of which
// kind of caller (guest or signed-in) is asking.

const hadE2EFlag = "JOBCHAT_E2E" in process.env;
const priorE2EFlag = process.env.JOBCHAT_E2E;
process.env.JOBCHAT_E2E = ""; // force the production (non-fixture) branch
afterAll(() => {
  if (hadE2EFlag) process.env.JOBCHAT_E2E = priorE2EFlag;
  else delete process.env.JOBCHAT_E2E;
});

const loadConversationMock = vi.fn();
const listOwnerConversationsMock = vi.fn(async (accountUserId: string) => {
  void accountUserId; // typed only so the mock accepts the real signature's argument
  return [] as Pick<Conversation, "id" | "title" | "created_at">[];
});
const resolveViewerMock = vi.fn();
vi.mock("@/lib/server-store", () => ({
  loadConversation: (id: string) => loadConversationMock(id),
  listOwnerConversations: (id: string) => listOwnerConversationsMock(id),
  resolveViewer: () => resolveViewerMock(),
}));

// ChatClient pulls in @ai-sdk/react and friends - irrelevant to the gate under test. Stubbed so the
// page's returned element's props can be asserted directly.
vi.mock("@/components/chat/ChatClient", () => ({
  ChatClient: (props: Record<string, unknown>) => ({
    type: "ChatClient",
    props,
  }),
}));

import ChatPage from "@/app/chat/[id]/page";

const CONVERSATION_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function conversation(userId: string): Conversation {
  return {
    id: CONVERSATION_ID,
    user_id: userId,
    title: "A thread",
    created_at: new Date(),
  };
}

const aMessage: Message = {
  id: "m1",
  conversation_id: CONVERSATION_ID,
  role: "user",
  content: "hi",
  parts: null,
  created_at: new Date(),
};

function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return {
    signedIn: false,
    ownerIds: [],
    accountUserId: null,
    accountName: null,
    accountEmail: null,
    ...overrides,
  };
}

async function renderPage() {
  const element = (await ChatPage({
    params: Promise.resolve({ id: CONVERSATION_ID }),
    searchParams: Promise.resolve({}),
  })) as unknown as {
    props: { initialMessages: unknown[]; title?: string; signedIn: boolean };
  };
  return element.props;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("chat/[id] resume gate (ruling 2: ownership keys on the resolved Viewer)", () => {
  it("Should_HydrateThread_When_GuestCookieOwnsTheConversation", async () => {
    loadConversationMock.mockResolvedValue({
      conversation: conversation("guest-1"),
      messages: [aMessage],
    });
    resolveViewerMock.mockResolvedValue(viewer({ ownerIds: ["guest-1"] }));

    const props = await renderPage();

    expect(props.title).toBe("A thread");
    expect(props.initialMessages).toHaveLength(1);
  });

  it("Should_HydrateThread_When_SignedInAccountOwnsItOnAnyDevice", async () => {
    // no guest cookie on THIS device - the resolved Viewer's account id is what matches (ruling 2's point)
    loadConversationMock.mockResolvedValue({
      conversation: conversation("account-1"),
      messages: [aMessage],
    });
    resolveViewerMock.mockResolvedValue(
      viewer({
        signedIn: true,
        ownerIds: ["account-1"],
        accountUserId: "account-1",
        accountName: "Ada",
      }),
    );

    const props = await renderPage();

    expect(props.title).toBe("A thread");
    expect(props.initialMessages).toHaveLength(1);
    expect(props.signedIn).toBe(true);
  });

  it("Should_RenderEmptyThread_When_CallerDoesNotOwnTheConversation", async () => {
    // the conversation exists (loadConversation resolves it) but neither the guest cookie nor the
    // signed-in account is its owner - fail-closed: no title, no messages leak to a non-owner.
    loadConversationMock.mockResolvedValue({
      conversation: conversation("someone-elses-row"),
      messages: [aMessage],
    });
    resolveViewerMock.mockResolvedValue(
      viewer({ ownerIds: ["guest-not-the-owner"] }),
    );

    const props = await renderPage();

    expect(props.title).toBeUndefined();
    expect(props.initialMessages).toEqual([]);
  });

  it("Should_RenderEmptyThread_When_ConversationIsUnknown", async () => {
    loadConversationMock.mockResolvedValue(null);
    resolveViewerMock.mockResolvedValue(viewer({ ownerIds: ["guest-1"] }));

    const props = await renderPage();

    expect(props.title).toBeUndefined();
    expect(props.initialMessages).toEqual([]);
  });

  it("Should_SeedSidebarHistory_OnlyForASignedInAccount", async () => {
    loadConversationMock.mockResolvedValue({
      conversation: conversation("account-1"),
      messages: [],
    });
    resolveViewerMock.mockResolvedValue(
      viewer({
        signedIn: true,
        ownerIds: ["account-1"],
        accountUserId: "account-1",
      }),
    );
    listOwnerConversationsMock.mockResolvedValue([
      { id: CONVERSATION_ID, title: "A thread", created_at: new Date() },
    ]);

    const props = (await renderPage()) as unknown as {
      conversations: unknown[];
    };

    expect(listOwnerConversationsMock).toHaveBeenCalledWith("account-1");
    expect(props.conversations).toHaveLength(1);
  });

  it("Should_NotQueryHistory_When_Guest", async () => {
    loadConversationMock.mockResolvedValue(null);
    resolveViewerMock.mockResolvedValue(viewer());

    await renderPage();

    expect(listOwnerConversationsMock).not.toHaveBeenCalled();
  });

  // 017 fix round 2 (must-fix 1): `/chat/new` is the landing-initiated sign-in's destination - a FRESH
  // chat shell (armed to start a new conversation on the first send), NOT a stored-conversation resume and
  // NOT a 404. "new" bypasses the UUID gate: nothing is loaded, but the signed-in account's history still
  // seeds the sidebar so the user lands "into the app".
  it("Should_RenderFreshShell_When_IdIsNew", async () => {
    resolveViewerMock.mockResolvedValue(
      viewer({
        signedIn: true,
        ownerIds: ["account-1"],
        accountUserId: "account-1",
        accountName: "Ada",
      }),
    );
    listOwnerConversationsMock.mockResolvedValue([
      { id: CONVERSATION_ID, title: "A thread", created_at: new Date() },
    ]);

    const element = (await ChatPage({
      params: Promise.resolve({ id: "new" }),
      searchParams: Promise.resolve({}),
    })) as unknown as {
      props: {
        newChat?: boolean;
        initialMessages: unknown[];
        conversations: unknown[];
        signedIn: boolean;
        pendingQuestion?: string;
      };
    };

    expect(element.props.newChat).toBe(true); // armed as a fresh chat shell
    expect(element.props.initialMessages).toEqual([]); // nothing resumed
    expect(element.props.pendingQuestion).toBeUndefined(); // no arrival question on a fresh shell (no ?q=)
    expect(loadConversationMock).not.toHaveBeenCalled(); // "new" is not a stored id - never queried
    expect(element.props.conversations).toHaveLength(1); // history still seeded for the signed-in account
    expect(element.props.signedIn).toBe(true);
  });

  // refresh #2 s10/s7: the landing's "Your profile" navigates to `/chat/new?profile=1`, which must open
  // the profile on arrival - prove the searchParams wiring itself (ChatClient's own open-on-arrival
  // behavior is covered separately in lcp.test.tsx).
  it("Should_ArmProfileOnArrival_When_ProfileParamIsOne", async () => {
    resolveViewerMock.mockResolvedValue(
      viewer({
        signedIn: true,
        ownerIds: ["account-1"],
        accountUserId: "account-1",
      }),
    );
    listOwnerConversationsMock.mockResolvedValue([]);

    const element = (await ChatPage({
      params: Promise.resolve({ id: "new" }),
      searchParams: Promise.resolve({ profile: "1" }),
    })) as unknown as { props: { profileOnArrival?: boolean } };

    expect(element.props.profileOnArrival).toBe(true);
  });

  it("Should_NotArmProfileOnArrival_When_NoProfileParam", async () => {
    loadConversationMock.mockResolvedValue(null);
    resolveViewerMock.mockResolvedValue(viewer({ ownerIds: ["guest-1"] }));

    const props = await renderPage();

    expect(
      (props as unknown as { profileOnArrival?: boolean }).profileOnArrival,
    ).toBe(false);
  });
});
