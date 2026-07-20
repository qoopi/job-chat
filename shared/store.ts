import type { Sql } from "postgres";

// The OLTP chat store: raw `postgres` + .sql migrations (no ORM, no repository layer - operator
// ruling). A deep module - callers get user/conversation/message persistence behind five methods;
// `null` always means "not found". The store mints/owns ids (guest id is the caller's cookie uuid;
// conversation/message ids default in Postgres). Accepts its `sql` client (testability), never
// creates one.

export type MessageRole = "user" | "assistant";

// Canonical UUID shape (8-4-4-4-12 hex). Postgres rejects a non-UUID id with a raw
// `invalid input syntax for type uuid`, which would break `getConversation`'s "null = not found"
// contract at the trust boundary (006 feeds it an untrusted `/chat/[id]` param). Guard before the
// query so a malformed id reads as "not found" - without swallowing real DB errors on a valid one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres unique_violation SQLSTATE. porsager/postgres surfaces the server's SQLSTATE as `err.code`
// on a PostgresError; `linkAuthUser` uses it to turn the auth_user_id UNIQUE race into a typed refusal.
const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === PG_UNIQUE_VIOLATION;
}

/** A persisted JSON payload (the insight-card parts). Opaque here; validated by `insight.ts`. */
export type Json = unknown;

export interface User {
  user_id: string;
  created_at: Date;
  auth_user_id: string | null; // Better Auth's user id once signed in (adoption stamps it); null for guests
}

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  parts: Json | null; // null for user messages; the insight payload for assistant messages
  created_at: Date;
}

export interface Store {
  getOrCreateUser(guestId: string): Promise<User>;
  createConversation(userId: string, firstQuestion: string): Promise<Conversation>;
  appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    parts: Json | null,
  ): Promise<Message>;
  getConversation(
    conversationId: string,
  ): Promise<{ conversation: Conversation; messages: Message[] } | null>;
  /**
   * The conversation's owner (user_id + the owner's auth_user_id), or `null` for an unknown/malformed
   * id. A lightweight authorization + guard lookup - conversations JOIN users, both PK/UNIQUE-indexed,
   * no message history (contrast `getConversation`, which loads the full, unbounded thread). The
   * auth_user_id (null = guest, set = signed-in) lets the run() backstop pick the cap by identity kind.
   */
  getConversationOwner(
    conversationId: string,
  ): Promise<{ user_id: string; auth_user_id: string | null } | null>;
  /** The users row linked to a Better Auth id, or `null` when unmapped. One indexed lookup. */
  findUserByAuthId(authUserId: string): Promise<User | null>;
  /**
   * Stamp a Better Auth id onto a users row (first sign-in; conversations follow for free). SECURITY:
   * stamps ONLY an unlinked guest row (auth_user_id IS NULL) - never overwrites another account's
   * binding. Returns whether it stamped: `false` when the row already carries a DIFFERENT auth_user_id
   * (0-row match) OR the auth_user_id UNIQUE race lost to a concurrent first sign-in (caught, not
   * thrown). On `false` the caller re-reads `findUserByAuthId` for the canonical row.
   */
  linkAuthUser(userId: string, authUserId: string): Promise<boolean>;
  /**
   * Adopt a guest's conversations into the canonical (account) row on sign-in: one UPDATE of
   * conversations.user_id, no message copying. Idempotent (a re-run moves nothing). SECURITY: moves
   * only FROM a genuine guest row (source auth_user_id IS NULL) - never adopts from a row that already
   * belongs to a DIFFERENT account (a forged guest cookie must not steal a signed-in user's chats).
   */
  adoptGuest(canonicalUserId: string, guestUserId: string): Promise<void>;
  /** A user's conversations, newest first (the signed-in sidebar history, AC-12). */
  listConversations(userId: string): Promise<Pick<Conversation, "id" | "title" | "created_at">[]>;
  /**
   * Delete a conversation and its messages (AC-21). Messages are removed first (the FK has no ON DELETE
   * CASCADE), both in one transaction so a conversation never outlives a partial message delete. A
   * malformed id is a no-op (the "null = not found" contract). Ownership is enforced by the CALLER (the
   * action layer resolves the caller's Identity and refuses a non-owner as not_found) - this primitive
   * deletes by id.
   */
  deleteConversation(conversationId: string): Promise<void>;
  /** Count user-turn messages since `sinceUtcMidnight`. No `userId` => global (the daily budget). */
  messageCounts(args: { userId?: string; sinceUtcMidnight: Date }): Promise<number>;
}

/**
 * Derive a conversation title from the first user question: whitespace-collapsed, trimmed to 60
 * chars on a word boundary, never null/empty (falls back to "New chat" for blank input). AC-14.
 */
export function deriveTitle(firstQuestion: string): string {
  const normalized = firstQuestion.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return "New chat";
  if (normalized.length <= 60) return normalized;
  const head = normalized.slice(0, 60);
  const lastSpace = head.lastIndexOf(" ");
  // Prefer the last word boundary; a single >60-char token has none, so hard-cut at 60.
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd();
}

export function createStore(sql: Sql): Store {
  return {
    async getOrCreateUser(guestId) {
      // DO UPDATE (a no-op reassignment) rather than DO NOTHING so RETURNING yields the row on
      // both insert and conflict; created_at is left untouched for an existing user.
      const rows = await sql<User[]>`
        INSERT INTO users (user_id) VALUES (${guestId})
        ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
        RETURNING user_id, created_at, auth_user_id`;
      return rows[0];
    },

    async createConversation(userId, firstQuestion) {
      const title = deriveTitle(firstQuestion);
      const rows = await sql<Conversation[]>`
        INSERT INTO conversations (user_id, title) VALUES (${userId}, ${title})
        RETURNING id, user_id, title, created_at`;
      return rows[0];
    },

    async appendMessage(conversationId, role, content, parts) {
      const rows = await sql<Message[]>`
        INSERT INTO messages (conversation_id, role, content, parts)
        VALUES (${conversationId}, ${role}, ${content}, ${
          parts === null ? null : sql.json(parts as never)
        })
        RETURNING id, conversation_id, role, content, parts, created_at`;
      return rows[0];
    },

    async getConversation(conversationId) {
      // A malformed id is "not found" from the caller's view (contract: null = not found).
      if (!UUID_RE.test(conversationId)) return null;
      const conversations = await sql<Conversation[]>`
        SELECT id, user_id, title, created_at
        FROM conversations WHERE id = ${conversationId}`;
      if (conversations.length === 0) return null;
      const messages = await sql<Message[]>`
        SELECT id, conversation_id, role, content, parts, created_at
        FROM messages WHERE conversation_id = ${conversationId}
        ORDER BY created_at ASC, id ASC`;
      return { conversation: conversations[0], messages: [...messages] };
    },

    async getConversationOwner(conversationId) {
      // Same "null = not found" contract as getConversation (malformed id reads as not found). One
      // JOIN of two indexed rows (conversations PK + users PK) - the auth_user_id rides along so the
      // guard picks the cap by kind - and still no message history.
      if (!UUID_RE.test(conversationId)) return null;
      const rows = await sql<{ user_id: string; auth_user_id: string | null }[]>`
        SELECT cv.user_id, u.auth_user_id
        FROM conversations cv JOIN users u ON u.user_id = cv.user_id
        WHERE cv.id = ${conversationId}`;
      return rows.length === 0 ? null : { user_id: rows[0].user_id, auth_user_id: rows[0].auth_user_id };
    },

    async findUserByAuthId(authUserId) {
      const rows = await sql<User[]>`
        SELECT user_id, created_at, auth_user_id FROM users WHERE auth_user_id = ${authUserId}`;
      return rows.length === 0 ? null : rows[0];
    },

    async linkAuthUser(userId, authUserId) {
      // Stamp only an unlinked guest row: the `auth_user_id IS NULL` guard refuses to overwrite a row
      // already bound to a DIFFERENT account (a forged/stale guest cookie must not take it over). A
      // 0-row match => already linked => `false`. The guard passes for the row's OWN NULL, but the SET
      // can still collide with the auth_user_id UNIQUE index when a concurrent first sign-in stamped
      // this id onto another row first - catch that race and report `false` (never an untyped 500); the
      // caller re-reads findUserByAuthId for the canonical winner.
      try {
        const rows = await sql`
          UPDATE users SET auth_user_id = ${authUserId}
          WHERE user_id = ${userId} AND auth_user_id IS NULL
          RETURNING user_id`;
        return rows.length > 0;
      } catch (e) {
        if (isUniqueViolation(e)) return false;
        throw e;
      }
    },

    async adoptGuest(canonicalUserId, guestUserId) {
      // Re-point the guest's conversations to the canonical row (messages ride along via
      // conversation_id - none are copied). Idempotent: a re-run matches zero rows. SECURITY: the
      // EXISTS guard moves conversations only when the SOURCE row is a genuine guest (auth_user_id IS
      // NULL) - never adopts FROM a row already bound to a DIFFERENT account (forged guest cookie).
      await sql`
        UPDATE conversations SET user_id = ${canonicalUserId}
        WHERE user_id = ${guestUserId}
          AND EXISTS (SELECT 1 FROM users WHERE user_id = ${guestUserId} AND auth_user_id IS NULL)`;
    },

    async listConversations(userId) {
      const rows = await sql<Pick<Conversation, "id" | "title" | "created_at">[]>`
        SELECT id, title, created_at FROM conversations
        WHERE user_id = ${userId}
        ORDER BY created_at DESC, id DESC`;
      return [...rows];
    },

    async deleteConversation(conversationId) {
      // Malformed id: no-op (contract parity with getConversation - never surface a raw uuid cast error).
      if (!UUID_RE.test(conversationId)) return;
      // One transaction: messages first (no ON DELETE CASCADE on the FK), then the conversation row.
      await sql.begin(async (tx) => {
        await tx`DELETE FROM messages WHERE conversation_id = ${conversationId}`;
        await tx`DELETE FROM conversations WHERE id = ${conversationId}`;
      });
    },

    async messageCounts({ userId, sinceUtcMidnight }) {
      const rows =
        userId === undefined
          ? await sql<{ c: number }[]>`
              SELECT count(*)::int AS c FROM messages
              WHERE role = 'user' AND created_at >= ${sinceUtcMidnight}`
          : await sql<{ c: number }[]>`
              SELECT count(*)::int AS c FROM messages m
              JOIN conversations cv ON cv.id = m.conversation_id
              WHERE m.role = 'user' AND cv.user_id = ${userId}
                AND m.created_at >= ${sinceUtcMidnight}`;
      return rows[0].c;
    },
  };
}
