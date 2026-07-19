import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { UIMessage } from "ai";
import { ChatClient } from "@/components/chat/ChatClient";
import { storeToUiMessages } from "@/lib/chat-ui";
import { e2eFixtureThread } from "@/lib/chat-fixtures";
import { loadConversation } from "@/lib/server-store";
import { isE2E } from "@/lib/e2e";

// The chat shell (mock 2a). Server-renders the conversation from the store (AC-13 resume: cards intact,
// no analytics re-query) and hands it to the live client (ChatClient) which attaches the stream. The
// route id is Zod-validated at the trust boundary: a malformed (non-UUID) :id is a bad route, not a
// blank new-chat shell, so it 404s (epic decision 2026-07-19, 006 review). Past that gate the id is a
// valid UUID (the store also returns null on a malformed id - the guard lives in both layers).
// Ownership is confirmed against the guest cookie so one guest can never resume another's thread.
const GUEST_COOKIE = "jobchat_guest";
const ConversationIdSchema = z.string().uuid();

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string; q?: string }>;
}) {
  const { id } = await params;
  if (!ConversationIdSchema.safeParse(id).success) notFound();
  const { new: isNew, q } = await searchParams;
  const e2e = isE2E();

  let title: string | undefined;
  let initialMessages: UIMessage[] = [];
  let pendingQuestion: string | undefined;

  if (e2e) {
    // No Postgres in the automated suite: resume from the fixture, or carry the landing question in.
    const fixture = e2eFixtureThread(id);
    if (fixture) {
      title = fixture.title;
      initialMessages = storeToUiMessages(fixture.messages);
    } else if (q) {
      pendingQuestion = q;
    }
  } else {
    const guestId = (await cookies()).get(GUEST_COOKIE)?.value;
    const loaded = await loadConversation(id);
    // Hydrate only the caller's own conversation (defense in depth beyond the token's ownership check).
    if (loaded && guestId && loaded.conversation.user_id === guestId) {
      title = loaded.conversation.title;
      initialMessages = storeToUiMessages(loaded.messages);
    }
  }

  return (
    <ChatClient
      conversationId={id}
      title={title}
      initialMessages={initialMessages}
      pendingQuestion={pendingQuestion}
      autoStream={isNew === "1"}
      e2e={e2e}
    />
  );
}
