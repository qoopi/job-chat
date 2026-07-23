import type { Sql } from "postgres";
import type { Profile, Skill } from "./profile";

// OLTP chat store (raw postgres, no ORM). Contract: `null` always means "not found".

export type MessageRole = "user" | "assistant";

// Postgres raises `invalid input syntax for type uuid` on a non-UUID id; guard untrusted ids so a
// malformed one reads as "not found" (the store's contract), never a 500.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres unique_violation SQLSTATE, surfaced by porsager/postgres as `err.code`; linkAuthUser turns
// the auth_user_id UNIQUE race into a typed refusal.
const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/** Opaque JSON payload; validated by `insight.ts`, not here. */
export type Json = unknown;

export interface User {
  user_id: string;
  created_at: Date;
  auth_user_id: string | null; // Better Auth id once signed in; null = guest
}

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
}

export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "created_at"
>;

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  parts: Json | null; // null for user messages; insight payload for assistant
  created_at: Date;
}

/** `extracted_at IS NOT NULL` = extraction done, `extraction_failed` = terminal failure; `resume_pdf`
 *  is transient PII, present only between save and task then NULLed once extraction terminates. */
export interface ProfileRow {
  user_id: string;
  raw_resume_text: string | null;
  resume_pdf: Uint8Array | null;
  github_username: string | null;
  profile: Profile | null; // null until the extraction task writes it
  extracted_at: Date | null; // null = extraction pending (or failed - see extraction_failed)
  extraction_failed: boolean; // true only after a permanent extraction failure
}

/** Raw profile inputs (pre-extraction write); a null field clears that input. */
export interface ProfileInputs {
  userId: string;
  rawResumeText: string | null;
  resumePdf: Uint8Array | null;
  githubUsername: string | null;
}

/** The user-editable preference fields on an extracted profile (the edit surface). A null salary or
 *  remotePref is "unknown"; empty locations clears them. These feed searchPostings via mergeSearchParams. */
export interface ProfilePrefs {
  salaryMin: number | null;
  locations: string[];
  remotePref: boolean | null;
}

export interface Store {
  getOrCreateUser(guestId: string): Promise<User>;
  createConversation(
    userId: string,
    firstQuestion: string,
  ): Promise<Conversation>;
  /** Append a message. A supplied `id` makes the insert idempotent (`ON CONFLICT (id) DO NOTHING`, first
   *  write wins) - load-bearing for crash-redispatch dedup; omit it to always insert. */
  appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    parts: Json | null,
    id?: string,
  ): Promise<Message>;
  getConversation(
    conversationId: string,
  ): Promise<{ conversation: Conversation; messages: Message[] } | null>;
  /** Owner (user_id + auth_user_id), or `null` for unknown/malformed id; auth_user_id null=guest picks the cap. */
  getConversationOwner(
    conversationId: string,
  ): Promise<{ user_id: string; auth_user_id: string | null } | null>;
  findUserByAuthId(authUserId: string): Promise<User | null>;
  /** SECURITY: stamps a Better Auth id ONLY onto an unlinked guest row (auth_user_id IS NULL) - never
   *  overwrites another account's binding. Returns `false` if already linked or the UNIQUE race lost. */
  linkAuthUser(userId: string, authUserId: string): Promise<boolean>;
  /** SECURITY: adopt a guest's conversations into the account row (one UPDATE, idempotent) only FROM a
   *  genuine guest row (auth_user_id IS NULL) - a forged guest cookie must not steal a user's chats. */
  adoptGuest(canonicalUserId: string, guestUserId: string): Promise<void>;
  listConversations(userId: string): Promise<ConversationSummary[]>;
  /** Delete a conversation and its messages in one transaction. Ownership is enforced by the CALLER. */
  deleteConversation(conversationId: string): Promise<void>;
  /** Set a conversation's title. Ownership + title validation are enforced by the CALLER (mirrors deleteConversation). */
  renameConversation(conversationId: string, title: string): Promise<void>;
  /** Count user-turn messages since `sinceUtcMidnight`. No `userId` => global (the daily budget). */
  messageCounts(args: {
    userId?: string;
    sinceUtcMidnight: Date;
  }): Promise<number>;
  /** Delete the assistant row(s) trailing the last user turn - the durable mirror of the SDK's regenerate
   *  pop. Regenerate path only; enforces exactly one assistant reply per user turn. No-op on a user-less
   *  or user-tailed conversation, or a malformed id. */
  deleteTrailingAssistant(conversationId: string): Promise<void>;
  /** REPLACE semantics via `ON CONFLICT (id) DO UPDATE` (contrast appendMessage's `DO NOTHING`): a
   *  deterministic id means a re-save updates the one card and can't duplicate it; `created_at` untouched
   *  keeps its thread position. Empty content - buildModelHistory drops the empty model-facing row. */
  appendProfileCard(
    conversationId: string,
    id: string,
    parts: Json,
  ): Promise<void>;
  getProfile(userId: string): Promise<ProfileRow | null>;
  /** Upsert raw inputs only; leaves profile/extracted_at UNTOUCHED (a failed re-extraction keeps the
   *  working profile) and clears extraction_failed (a re-save is a fresh attempt). */
  saveProfileInputs(inputs: ProfileInputs): Promise<void>;
  /** Write the extracted profile (`profile` + `extracted_at`); does NOT clear `resume_pdf`. Returns
   *  `false` if the row was deleted mid-extraction (caller then skips the orphan card). */
  saveExtractedProfile(userId: string, profile: Profile): Promise<boolean>;
  /** Patch the editable preference fields (salaryMin/locations/remotePref) on the caller's EXTRACTED
   *  profile via a targeted jsonb merge - titles/skills/experience are untouched. Returns the updated
   *  Profile, or null when the user has no extracted profile row (nothing to edit). Ownership is the
   *  userId scope (the CALLER passes its own id, mirroring the other profile methods). */
  updateProfilePrefs(userId: string, prefs: ProfilePrefs): Promise<Profile | null>;
  /** Replace the skills array on the caller's EXTRACTED profile (jsonb merge; the caller supplies the full
   *  validated array, sources included). Returns the updated Profile, or null when there is no extracted
   *  profile row. Ownership is the userId scope, exactly like updateProfilePrefs. */
  updateProfileSkills(userId: string, skills: Skill[]): Promise<Profile | null>;
  /** Clear the transient resume PDF - the terminal PII clear-point on the success path. */
  clearResumePdf(userId: string): Promise<void>;
  /** onFailure (all retries spent): NULL `resume_pdf` (transient PII must never linger) and set
   *  `extraction_failed`, but ONLY when no profile was produced (`extracted_at IS NULL`). */
  markExtractionFailed(userId: string): Promise<void>;
  deleteProfile(userId: string): Promise<void>;
  deleteMessage(conversationId: string, id: string): Promise<void>;
}

export function deriveTitle(firstQuestion: string): string {
  const normalized = firstQuestion.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return "New chat";
  if (normalized.length <= 60) return normalized;
  const head = normalized.slice(0, 60);
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd();
}

export function createStore(sql: Sql): Store {
  return {
    async getOrCreateUser(guestId) {
      // DO UPDATE (no-op reassignment), not DO NOTHING, so RETURNING yields the row on conflict too.
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

    async appendMessage(conversationId, role, content, parts, id) {
      const partsValue = parts === null ? null : sql.json(parts as never);
      const rows =
        id === undefined
          ? await sql<Message[]>`
              INSERT INTO messages (conversation_id, role, content, parts)
              VALUES (${conversationId}, ${role}, ${content}, ${partsValue})
              RETURNING id, conversation_id, role, content, parts, created_at`
          : await sql<Message[]>`
              INSERT INTO messages (id, conversation_id, role, content, parts)
              VALUES (${id}, ${conversationId}, ${role}, ${content}, ${partsValue})
              ON CONFLICT (id) DO NOTHING
              RETURNING id, conversation_id, role, content, parts, created_at`;
      return rows[0];
    },

    async getConversation(conversationId) {
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
      if (!UUID_RE.test(conversationId)) return null;
      const rows = await sql<
        { user_id: string; auth_user_id: string | null }[]
      >`
        SELECT cv.user_id, u.auth_user_id
        FROM conversations cv JOIN users u ON u.user_id = cv.user_id
        WHERE cv.id = ${conversationId}`;
      return rows.length === 0
        ? null
        : { user_id: rows[0].user_id, auth_user_id: rows[0].auth_user_id };
    },

    async findUserByAuthId(authUserId) {
      const rows = await sql<User[]>`
        SELECT user_id, created_at, auth_user_id FROM users WHERE auth_user_id = ${authUserId}`;
      return rows.length === 0 ? null : rows[0];
    },

    async linkAuthUser(userId, authUserId) {
      // Catch the auth_user_id UNIQUE-race loss (concurrent sign-in) as `false`, not a 500.
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
      // SECURITY: the EXISTS guard moves conversations only from a genuine guest row (auth_user_id IS NULL).
      await sql`
        UPDATE conversations SET user_id = ${canonicalUserId}
        WHERE user_id = ${guestUserId}
          AND EXISTS (SELECT 1 FROM users WHERE user_id = ${guestUserId} AND auth_user_id IS NULL)`;
    },

    async listConversations(userId) {
      const rows = await sql<ConversationSummary[]>`
        SELECT c.id, c.title, c.created_at
        FROM conversations c
        WHERE c.user_id = ${userId}
        ORDER BY c.created_at DESC, c.id DESC`;
      return [...rows];
    },

    async deleteConversation(conversationId) {
      if (!UUID_RE.test(conversationId)) return;
      // messages first: the FK has no ON DELETE CASCADE.
      await sql.begin(async (tx) => {
        await tx`DELETE FROM messages WHERE conversation_id = ${conversationId}`;
        await tx`DELETE FROM conversations WHERE id = ${conversationId}`;
      });
    },

    async renameConversation(conversationId, title) {
      if (!UUID_RE.test(conversationId)) return;
      await sql`UPDATE conversations SET title = ${title} WHERE id = ${conversationId}`;
    },

    async deleteTrailingAssistant(conversationId) {
      if (!UUID_RE.test(conversationId)) return;
      // "Trailing" = no user row sorts at-or-after it, by the same (created_at, id) order getConversation
      // reads. Exclude the out-of-band profile-card row (`IS DISTINCT FROM` keeps null-parts rows eligible)
      // so a Retry after a save never destroys the card.
      await sql`
        DELETE FROM messages a
        WHERE a.conversation_id = ${conversationId}
          AND a.role = 'assistant'
          AND (a.parts->>'kind') IS DISTINCT FROM 'profile-card'
          AND EXISTS (
            SELECT 1 FROM messages u
            WHERE u.conversation_id = ${conversationId} AND u.role = 'user'
          )
          AND NOT EXISTS (
            SELECT 1 FROM messages u
            WHERE u.conversation_id = ${conversationId} AND u.role = 'user'
              AND (u.created_at, u.id) >= (a.created_at, a.id)
          )`;
    },

    async appendProfileCard(conversationId, id, parts) {
      await sql`
        INSERT INTO messages (id, conversation_id, role, content, parts)
        VALUES (${id}, ${conversationId}, 'assistant', '', ${sql.json(parts as never)})
        ON CONFLICT (id) DO UPDATE
          SET content = EXCLUDED.content, parts = EXCLUDED.parts`;
    },

    async getProfile(userId) {
      const rows = await sql<ProfileRow[]>`
        SELECT user_id, raw_resume_text, resume_pdf, github_username, profile, extracted_at, extraction_failed
        FROM profiles WHERE user_id = ${userId}`;
      return rows.length === 0 ? null : rows[0];
    },

    async saveProfileInputs({ userId, rawResumeText, resumePdf, githubUsername }) {
      await sql`
        INSERT INTO profiles (user_id, raw_resume_text, resume_pdf, github_username)
        VALUES (${userId}, ${rawResumeText}, ${resumePdf}, ${githubUsername})
        ON CONFLICT (user_id) DO UPDATE SET
          raw_resume_text = EXCLUDED.raw_resume_text,
          resume_pdf = EXCLUDED.resume_pdf,
          github_username = EXCLUDED.github_username,
          extraction_failed = FALSE`;
    },

    async saveExtractedProfile(userId, profile) {
      const result = await sql`
        UPDATE profiles
        SET profile = ${sql.json(profile as never)}, extracted_at = now(), extraction_failed = FALSE
        WHERE user_id = ${userId}`;
      return result.count > 0;
    },

    async updateProfilePrefs(userId, prefs) {
      // jsonb `||` shallow-merges the three keys onto the stored profile, leaving every other field
      // intact. `profile IS NOT NULL` scopes the edit to an EXTRACTED profile (a pending row has nothing
      // to edit), so a missing/pending row matches zero rows -> null (the action reads it as not_found).
      const rows = await sql<{ profile: Profile }[]>`
        UPDATE profiles SET profile = profile || ${sql.json(prefs as never)}::jsonb
        WHERE user_id = ${userId} AND profile IS NOT NULL
        RETURNING profile`;
      return rows.length === 0 ? null : rows[0].profile;
    },

    async updateProfileSkills(userId, skills) {
      // Same targeted jsonb merge as updateProfilePrefs, replacing only the `skills` array.
      const rows = await sql<{ profile: Profile }[]>`
        UPDATE profiles SET profile = profile || ${sql.json({ skills } as never)}::jsonb
        WHERE user_id = ${userId} AND profile IS NOT NULL
        RETURNING profile`;
      return rows.length === 0 ? null : rows[0].profile;
    },

    async clearResumePdf(userId) {
      await sql`UPDATE profiles SET resume_pdf = NULL WHERE user_id = ${userId}`;
    },

    async markExtractionFailed(userId) {
      await sql`
        UPDATE profiles
        SET resume_pdf = NULL, extraction_failed = (extracted_at IS NULL)
        WHERE user_id = ${userId}`;
    },

    async deleteProfile(userId) {
      await sql`DELETE FROM profiles WHERE user_id = ${userId}`;
    },

    async deleteMessage(conversationId, id) {
      if (!UUID_RE.test(conversationId) || !UUID_RE.test(id)) return;
      await sql`DELETE FROM messages WHERE id = ${id} AND conversation_id = ${conversationId}`;
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
