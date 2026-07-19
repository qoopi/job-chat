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

/** A persisted JSON payload (the insight-card parts). Opaque here; validated by `insight.ts`. */
export type Json = unknown;

export interface User {
  user_id: string;
  created_at: Date;
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
   * The conversation's owner id, or `null` for an unknown/malformed id. A lightweight
   * authorization + guard lookup - one indexed row, no message history (contrast `getConversation`,
   * which loads the full, unbounded thread).
   */
  getConversationOwner(conversationId: string): Promise<{ user_id: string } | null>;
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
        RETURNING user_id, created_at`;
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
      // Same "null = not found" contract as getConversation (malformed id reads as not found), but
      // one row and no message join - the authorization + guard path never needs the history.
      if (!UUID_RE.test(conversationId)) return null;
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM conversations WHERE id = ${conversationId}`;
      return rows.length === 0 ? null : { user_id: rows[0].user_id };
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
