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
} from "@/lib/server-store";
import { isE2E } from "@/lib/e2e";

// The chat shell (mock 2a). Server-renders the conversation from the store (AC-13 resume: cards intact,
// no analytics re-query) and hands it to the live client (ChatClient) which attaches the stream. The
// route id is Zod-validated at the trust boundary: a malformed (non-UUID) :id is a bad route, not a
// blank new-chat shell, so it 404s (epic decision 2026-07-19, 006 review). Past that gate the id is a
// valid UUID (the store also returns null on a malformed id - the guard lives in both layers).
// Ownership is confirmed against the resolved Viewer (guest cookie OR the signed-in account's chat-user
// row - ruling 2) so a signed-in account resumes its OWN conversation on any device, and no one else's.
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
  // `/chat/new` (017 fix round 2): a fresh chat shell, NOT a stored conversation - the landing-initiated
  // sign-in's destination. It bypasses the UUID gate (nothing to resume), still seeds the signed-in
  // account's history, and arms ChatClient to start a new conversation on the first send.
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

  if (e2e) {
    // No Postgres in the automated suite: resume from the fixture, or carry the landing question in. A
    // fresh shell resumes nothing (no fixture lookup for "new"). The E2E-only fixtures live in tests/ and
    // are dynamic-imported behind this flag, so a production build's module graph never pulls in test code.
    const { e2eFixtureThread } = await import(
      "../../../../tests/e2e/chat-fixtures"
    );
    const fixture = isNewChat ? undefined : e2eFixtureThread(id);
    if (fixture) {
      title = fixture.title;
      initialMessages = storeToUiMessages(fixture.messages);
    } else if (q) {
      pendingQuestion = q;
    }
  } else {
    const viewer = await resolveViewer();
    // A fresh shell has no thread to load - only the account context (sign-in state + history).
    if (!isNewChat) {
      const loaded = await loadConversation(id);
      // Hydrate only when the caller owns the conversation (guest cookie or signed-in account) - defense
      // in depth beyond the token's ownership check; fail-closed for a non-owner (empty thread).
      if (loaded && viewer.ownerIds.includes(loaded.conversation.user_id)) {
        title = loaded.conversation.title;
        initialMessages = storeToUiMessages(loaded.messages);
      }
    }
    // AC-11 arrival: turn 1's question rides `?q=`. ChatClient delivers it on mount via the public send
    // path, reusing message #1's id (from the loaded thread) so the streamed turn renders once.
    if (q) pendingQuestion = q;
    signedIn = viewer.signedIn;
    accountName = viewer.accountName ?? undefined;
    accountEmail = viewer.accountEmail ?? undefined;
    conversations = viewer.accountUserId
      ? await listOwnerConversations(viewer.accountUserId)
      : [];
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
    />
  );
}
