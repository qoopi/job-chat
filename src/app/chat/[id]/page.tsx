import { cookies } from "next/headers";
import { z } from "zod";
import type { UIMessage } from "ai";
import { ChatClient } from "@/components/chat/ChatClient";
import { storeToUiMessages } from "@/lib/chat-ui";
import { e2eFixtureThread } from "@/lib/chat-fixtures";
import { loadConversation } from "@/lib/server-store";
import { isE2E } from "@/lib/e2e";

// The chat shell (mock 2a). Server-renders the conversation from the store (AC-13 resume: cards intact,
// no analytics re-query) and hands it to the live client (ChatClient) which attaches the stream. The
// route id is Zod-validated at the trust boundary before any store/token call (epic decision: the
// guard lives in BOTH layers - the store also returns null on a malformed id). Ownership is confirmed
// against the guest cookie so one guest can never resume another's thread.
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
  const { new: isNew, q } = await searchParams;
  const e2e = isE2E();
  const valid = ConversationIdSchema.safeParse(id).success;

  let title: string | undefined;
  let initialMessages: UIMessage[] = [];
  let pendingQuestion: string | undefined;

  if (e2e) {
    // No Postgres in the automated suite: resume from the fixture, or carry the landing question in.
    const fixture = valid ? e2eFixtureThread(id) : null;
    if (fixture) {
      title = fixture.title;
      initialMessages = storeToUiMessages(fixture.messages);
    } else if (q) {
      pendingQuestion = q;
    }
  } else if (valid) {
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
