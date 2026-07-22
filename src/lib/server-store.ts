import "server-only";
import { cookies, headers } from "next/headers";
import postgres, { type Sql } from "postgres";
import {
  createStore,
  type ConversationSummary,
  type Store,
} from "@shared/store";
import { auth as authServer } from "@/lib/auth";
import { GUEST_COOKIE } from "@/lib/guest-cookie";

// Server-only Postgres for the resume render: a lazy singleton pool (build passes with no .env). Cached on
// globalThis (shared key with actions.ts) so dev HMR reuses ONE porsager client, not a leak per reload.
const globalForSql = globalThis as unknown as { __jobchatSql?: Sql };
function store(): Store {
  return createStore(
    (globalForSql.__jobchatSql ??= postgres(process.env.DATABASE_URL!)),
  );
}

/** The caller resolved for the resume render - read-only (NO adoption). `ownerIds` = who may resume (guest
 *  cookie + the linked account's row); `accountUserId` feeds the sidebar history. */
export type Viewer = {
  signedIn: boolean;
  ownerIds: string[];
  accountUserId: string | null;
  accountName: string | null;
  accountEmail: string | null;
};

export function loadConversation(conversationId: string) {
  return store().getConversation(conversationId);
}

/** Resolve the caller for the resume render (guest cookie + any verified auth session). Read-only - no
 *  adoption. A non-owner falls through to an empty thread (fail-closed); auth misconfig degrades to guest-only. */
export async function resolveViewer(): Promise<Viewer> {
  const guestId = (await cookies()).get(GUEST_COOKIE)?.value;
  const ownerIds: string[] = [];
  if (guestId) ownerIds.push(guestId);
  let signedIn = false;
  let accountUserId: string | null = null;
  let accountName: string | null = null;
  let accountEmail: string | null = null;
  try {
    const session = await authServer.api.getSession({
      headers: await headers(),
    });
    const authUserId = session?.user?.id;
    if (authUserId) {
      signedIn = true;
      accountName = session?.user?.name || session?.user?.email || null;
      accountEmail = session?.user?.email || null;
      const account = await store().findUserByAuthId(authUserId);
      if (account) {
        accountUserId = account.user_id;
        if (!ownerIds.includes(account.user_id)) ownerIds.push(account.user_id);
      }
    }
  } catch {
    // auth misconfig / no session -> guest-only ownership; never break the resume render
  }
  return { signedIn, ownerIds, accountUserId, accountName, accountEmail };
}

export function listOwnerConversations(
  accountUserId: string,
): Promise<ConversationSummary[]> {
  return store().listConversations(accountUserId);
}
