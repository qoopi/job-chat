import { notFound } from "next/navigation";
import { z } from "zod";
import type { UIMessage } from "ai";
import type { ConversationSummary } from "@shared/store";
import { ChatClient } from "@/components/chat/ChatClient";
import { storeToUiMessages } from "@/lib/chat-ui";
import {
  loadConversation,
  listOwnerConversations,
  resolveViewer,
  viewerHasProfile,
} from "@/lib/server-store";
import { isE2E } from "@/lib/e2e";
import { e2eFixtureThread } from "@/lib/e2e-fixtures";

// The chat shell: server-renders the conversation from the store (resume, no analytics re-query). The route
// id is Zod-validated at the trust boundary (a non-UUID :id 404s); ownership is confirmed against the Viewer.
const ConversationIdSchema = z.string().uuid();

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    q?: string;
    profile?: string;
    fromAuth?: string;
  }>;
}) {
  const { id } = await params;
  // `/chat/new`: a fresh shell (not a stored conversation) - bypasses the UUID gate, still seeds history, arms a new conversation.
  const isNewChat = id === "new";
  if (!isNewChat && !ConversationIdSchema.safeParse(id).success) notFound();
  const { q, profile, fromAuth } = await searchParams;
  const e2e = isE2E();

  let title: string | undefined;
  let initialMessages: UIMessage[] = [];
  let pendingQuestion: string | undefined;
  let signedIn = false;
  let conversations: ConversationSummary[] = [];
  let accountName: string | undefined;
  let accountEmail: string | undefined;
  // Whether the returning account already has a profile - only the post-auth arrival consumes it,
  // so it is read (via the existing store, no new endpoint) only on that path.
  let hasProfile = false;

  if (e2e) {
    // No Postgres in the suite: resume from the fixture. `e2eFixtureThread` is the production STUB (prod never calls this).
    const fixture = isNewChat ? undefined : e2eFixtureThread(id);
    if (fixture) {
      title = fixture.title;
      initialMessages = storeToUiMessages(fixture.messages);
    } else if (q) {
      pendingQuestion = q;
    }
  } else {
    const viewer = await resolveViewer();
    if (!isNewChat) {
      const loaded = await loadConversation(id);
      // Hydrate only when the caller owns the conversation (defense in depth); fail-closed for a non-owner (empty thread).
      if (loaded && viewer.ownerIds.includes(loaded.conversation.user_id)) {
        title = loaded.conversation.title;
        initialMessages = storeToUiMessages(loaded.messages);
      }
    }
    // Arrival: turn 1's `?q=` is delivered on mount via the public send path, reusing message #1's id (renders once).
    if (q) pendingQuestion = q;
    signedIn = viewer.signedIn;
    accountName = viewer.accountName ?? undefined;
    accountEmail = viewer.accountEmail ?? undefined;
    conversations = viewer.accountUserId
      ? await listOwnerConversations(viewer.accountUserId)
      : [];
    if (fromAuth === "1" && viewer.accountUserId) {
      hasProfile = await viewerHasProfile(viewer.accountUserId);
    }
  }

  return (
    <ChatClient
      conversationId={id}
      title={title}
      initialMessages={initialMessages}
      pendingQuestion={pendingQuestion}
      newChat={isNewChat}
      e2e={e2e}
      signedIn={signedIn}
      accountName={accountName}
      accountEmail={accountEmail}
      conversations={conversations}
      profileOnArrival={profile === "1"}
      fromAuth={fromAuth === "1"}
      hasProfile={hasProfile}
    />
  );
}
