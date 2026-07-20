import "server-only";
import { cookies, headers } from "next/headers";
import postgres, { type Sql } from "postgres";
import { createStore, type Conversation, type Store } from "@shared/store";
import { auth as authServer } from "@/lib/auth";

// Server-only Postgres access for the chat page's resume render (AC-13). A lazy singleton pool (no
// connection until first query, so the build passes with no .env), mirroring the actions layer. Kept
// out of "use server" so a Server Component can await it directly during render; `server-only` makes a
// stray client import a build error.
let sqlSingleton: Sql | undefined;
function store(): Store {
  return createStore((sqlSingleton ??= postgres(process.env.DATABASE_URL!)));
}

const GUEST_COOKIE = "jobchat_guest";

/** The current caller resolved for the resume render - read-only (NO adoption; that binds to the
 *  sign-in transition action). `ownerIds` is who may resume a conversation (guest cookie + the linked
 *  account's chat-user row); `accountUserId` feeds the sidebar history. */
export type Viewer = {
  signedIn: boolean;
  ownerIds: string[];
  accountUserId: string | null;
  accountName: string | null;
};

/** The stored conversation + messages, or `null` for an unknown/malformed id (store contract). */
export function loadConversation(conversationId: string) {
  return store().getConversation(conversationId);
}

/**
 * Resolve the caller for the resume render (ruling 2): the guest cookie plus any verified Better Auth
 * session mapped to its chat-user row. Read-only - adoption never runs during render. A signed-in
 * account's own conversation (its `user_id` matches `accountUserId`) hydrates on any device; a
 * non-owner falls through to an empty thread (fail-closed). Auth misconfig / no session degrades to
 * guest-only and never breaks the render.
 */
export async function resolveViewer(): Promise<Viewer> {
  const guestId = (await cookies()).get(GUEST_COOKIE)?.value;
  const ownerIds: string[] = [];
  if (guestId) ownerIds.push(guestId);
  let signedIn = false;
  let accountUserId: string | null = null;
  let accountName: string | null = null;
  try {
    const session = await authServer.api.getSession({ headers: await headers() });
    const authUserId = session?.user?.id;
    if (authUserId) {
      signedIn = true;
      accountName = session?.user?.name || session?.user?.email || null;
      const account = await store().findUserByAuthId(authUserId);
      if (account) {
        accountUserId = account.user_id;
        if (!ownerIds.includes(account.user_id)) ownerIds.push(account.user_id);
      }
    }
  } catch {
    // auth misconfig / no session -> guest-only ownership; never break the resume render
  }
  return { signedIn, ownerIds, accountUserId, accountName };
}

/** AC-12 (initial SSR list): the account's conversations, newest first, for the sidebar history. */
export function listOwnerConversations(
  accountUserId: string,
): Promise<Pick<Conversation, "id" | "title" | "created_at">[]> {
  return store().listConversations(accountUserId);
}
