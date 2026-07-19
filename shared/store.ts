import type { Sql } from "postgres";

// The OLTP chat store: raw `postgres` + .sql migrations (no ORM, no repository layer - operator
// ruling). A deep module - callers get user/conversation/message persistence behind five methods;
// `null` always means "not found". The store mints/owns ids (guest id is the caller's cookie uuid;
// conversation/message ids default in Postgres). Accepts its `sql` client (testability), never
// creates one.

export type MessageRole = "user" | "assistant";

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
