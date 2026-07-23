"use server";

import { cookies, headers } from "next/headers";
import { auth, runs, tasks } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { createStore, type ConversationSummary } from "@shared/store";
import type { Profile } from "@shared/profile";
import { profileCardMessageId } from "../../trigger/profile-card-id";
import type { extractProfileTask } from "../../trigger/extract-profile";
import { getGuardConfig } from "@shared/env";
import { isE2E } from "@/lib/e2e";
import { auth as authServer } from "@/lib/auth";
import { GUEST_COOKIE } from "@/lib/guest-cookie";
import { getJobchatSql } from "@/lib/jobchat-sql";
import { AGENT_ID } from "../../trigger/agent-id";
import {
  chatTokenScopes,
  createSessionService,
  resolveIdentity,
  type DeleteResult,
  type Identity,
  type MintResult,
  type MintToken,
  type RenameResult,
  type SendResult,
  type SessionResult,
} from "../../trigger/session";
import type { jobChatAgent } from "../../trigger/chat";

// The session server actions: a thin Next.js adapter over the injectable session core (trigger/session.ts).
// Outcomes are typed (no throws); this file holds ONLY async server actions ("use server" contract).

const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// The transport's startSession action: called lazily on the first sendMessage - atomically creates the
// Session, triggers the first run, returns the session-scoped token. THE turn-1 delivery seam.
export const startChatSession = chat.createStartSessionAction<typeof jobChatAgent>(AGENT_ID);

// The re-mint the transport reconnects with, server-side so the secret key never reaches the browser (ownership-gated).
const mintToken: MintToken = (conversationId) =>
  auth.createPublicToken({
    scopes: chatTokenScopes(conversationId),
    expirationTime: "1h",
  });

function service() {
  return createSessionService({
    store: createStore(getJobchatSql()),
    guards: getGuardConfig(),
    mintToken,
    now: () => new Date(),
  });
}

/** Read the guest cookie WITHOUT the getOrCreateUser upsert (for actions where the caller must already
 *  exist); no cookie => owns nothing => the ownership check refuses anyway. */
async function guestIdFromCookie(): Promise<string | undefined> {
  return (await cookies()).get(GUEST_COOKIE)?.value;
}

/** The signed-in Better Auth user, or undefined for a guest. A read failure degrades to guest (never breaks guest chat); E2E short-circuits. */
async function currentAuthUser(): Promise<
  { id: string; name?: string } | undefined
> {
  if (isE2E()) return undefined;
  try {
    const session = await authServer.api.getSession({
      headers: await headers(),
    });
    if (!session?.user?.id) return undefined;
    return { id: session.user.id, name: session.user.name ?? undefined };
  } catch {
    return undefined;
  }
}

async function currentAuthUserId(): Promise<string | undefined> {
  return (await currentAuthUser())?.id;
}

/** Resolve the caller's chat Identity for a follow-up action (guest cookie + any auth session); null => owns nothing => not_found. */
async function resolveCaller(): Promise<Identity | null> {
  const guestId = await guestIdFromCookie();
  const authUserId = await currentAuthUserId();
  if (!guestId && !authUserId) return null;
  return resolveIdentity(createStore(getJobchatSql()), { authUserId, guestId });
}

/** First visit mints an httpOnly cookie guest id + a users row. SECURITY: the guest id is an UNSIGNED
 *  bearer cookie (forgeable); signing it is an accepted residual for the hackathon. */
export async function ensureGuest(): Promise<string> {
  const jar = await cookies();
  let guestId = jar.get(GUEST_COOKIE)?.value;
  if (!guestId) {
    guestId = crypto.randomUUID();
    jar.set(GUEST_COOKIE, guestId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: GUEST_COOKIE_MAX_AGE,
    });
  }
  // E2E has no Postgres: the cookie is the slice under test (the users-row half is covered by integration tests).
  if (isE2E()) return guestId;
  await createStore(getJobchatSql()).getOrCreateUser(guestId);
  return guestId;
}

/** Landing handoff: create the conversation + persist message #1, return its id. Turn 1 rides the client's public send path (no server trigger). */
export async function startConversation(
  question: string,
): Promise<SessionResult> {
  const guestId = await ensureGuest();
  const authUserId = await currentAuthUserId();
  const identity = await resolveIdentity(createStore(getJobchatSql()), {
    authUserId,
    guestId,
  });
  return service().startConversation(identity.userId, question, identity.kind);
}

/** Follow-up send GATE: input-bounded, ownership-checked, cap/budget guarded. A pure gate - no persist/trigger/mint. */
export async function sendMessage(
  conversationId: string,
  text: string,
): Promise<SendResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().sendMessage(
    conversationId,
    text,
    identity.userId,
    identity.kind,
  );
}

/** Re-mint a session-scoped token, but only for the caller's OWN conversation (else not_found - a token never grants another's session). */
export async function mintChatToken(
  conversationId: string,
): Promise<MintResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().mintChatToken(conversationId, identity.userId);
}

/** The sign-in TRANSITION: binds the fresh auth session to the chat identity (resolveIdentity adopts the
 *  guest's conversations, guarded), then clears the guest cookie so the per-request path never re-adopts. */
export async function completeSignIn(): Promise<{
  ok: boolean;
  name?: string;
}> {
  const user = await currentAuthUser();
  if (!user) return { ok: false };
  const guestId = await guestIdFromCookie();
  await resolveIdentity(createStore(getJobchatSql()), { authUserId: user.id, guestId });
  // Delete with the SAME path the cookie was SET with; a path mismatch can leave the browser cookie in place.
  if (guestId) (await cookies()).delete({ name: GUEST_COOKIE, path: "/" });
  return { ok: true, name: user.name };
}

export async function clearGuestSession(): Promise<void> {
  (await cookies()).delete({ name: GUEST_COOKIE, path: "/" });
}

export async function listMyConversations(): Promise<ConversationSummary[]> {
  const identity = await resolveCaller();
  if (!identity) return [];
  return createStore(getJobchatSql()).listConversations(identity.userId);
}

/** Delete one of the caller's OWN conversations (non-owner reads as not_found - never deletes another's thread). */
export async function deleteConversation(
  conversationId: string,
): Promise<DeleteResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().deleteConversation(conversationId, identity.userId);
}

/** Rename one of the caller's OWN conversations (non-owner reads as not_found); returns the stored (trimmed) title. */
export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<RenameResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().renameConversation(conversationId, title, identity.userId);
}

// Server cap on the DECODED resume PDF (a hair over ~4MB so a legit file isn't rejected). next.config raises
// the Server Action body limit to 6mb for the base64-inflated payload.
const MAX_RESUME_PDF_BYTES = Math.floor(4.5 * 1024 * 1024);

/** The caller's own profile, sanitized (NEVER the transient PDF bytes), for the detail panel poll: the structured
 *  profile (null while pending), the github username, and extracted_at (null = pending). */
export interface MyProfile {
  profile: Profile | null;
  githubUsername: string | null;
  extractedAt: string | null;
  extractionFailed: boolean; // true = the extraction task permanently failed; the panel stops polling
}

export type SaveProfileInput = {
  conversationId: string;
  resumeText?: string;
  resumePdf?: { bytes: string; name: string };
  githubUsername?: string;
};

export type SaveProfileResult =
  | { ok: true; taskState: "queued"; runId: string }
  | { ok: false; reason: "unauthorized" | "too-large" | "empty" | "enqueue-failed" };

function trimmedOrNull(value: string | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

/** Store the profile inputs + kick off background extraction. SECURITY: signed-in only AND the conversation
 *  must be the caller's OWN (a forged id can't append a card to another's thread). Returns the queued task state. */
export async function saveProfile(
  input: SaveProfileInput,
): Promise<SaveProfileResult> {
  const identity = await resolveCaller();
  if (!identity || identity.kind !== "account") {
    return { ok: false, reason: "unauthorized" };
  }
  const store = createStore(getJobchatSql());
  const owner = await store.getConversationOwner(input.conversationId);
  if (!owner || owner.user_id !== identity.userId) {
    return { ok: false, reason: "unauthorized" };
  }

  const rawResumeText = trimmedOrNull(input.resumeText);
  const githubUsername = trimmedOrNull(input.githubUsername);
  let resumePdf: Uint8Array | null = null;
  if (input.resumePdf && input.resumePdf.bytes.length > 0) {
    const bytes = Buffer.from(input.resumePdf.bytes, "base64");
    if (bytes.length > MAX_RESUME_PDF_BYTES) return { ok: false, reason: "too-large" };
    resumePdf = bytes;
  }
  // Nothing to extract from: refuse rather than trigger a task that would produce an empty profile.
  if (!rawResumeText && !resumePdf && !githubUsername) {
    return { ok: false, reason: "empty" };
  }

  await store.saveProfileInputs({
    userId: identity.userId,
    rawResumeText,
    resumePdf,
    githubUsername,
  });

  // Inputs already stored; if enqueue fails, return a typed reason (the row sits pending - a re-save re-triggers).
  let handle: { id: string };
  try {
    handle = await tasks.trigger<typeof extractProfileTask>("extract-profile", {
      userId: identity.userId,
      conversationId: input.conversationId,
    });
  } catch (err) {
    console.error("[saveProfile] extract-profile enqueue failed", err);
    return { ok: false, reason: "enqueue-failed" };
  }
  return { ok: true, taskState: "queued", runId: handle.id };
}

/** The detail panel poll read: the caller's own profile, sanitized; null for a guest or a caller with no profile row. */
export async function getMyProfile(): Promise<MyProfile | null> {
  const identity = await resolveCaller();
  if (!identity || identity.kind !== "account") return null;
  const row = await createStore(getJobchatSql()).getProfile(identity.userId);
  if (!row) return null;
  return {
    profile: row.profile,
    githubUsername: row.github_username,
    extractedAt: row.extracted_at ? row.extracted_at.toISOString() : null,
    extractionFailed: row.extraction_failed,
  };
}

/** Delete the caller's profile (idempotent). When a conversationId the caller owns is passed, the profile
 *  CARD in that active conversation is also deleted; orphan cards in other conversations stay as history. */
export async function deleteProfile(conversationId?: string): Promise<{ ok: boolean }> {
  const identity = await resolveCaller();
  if (!identity || identity.kind !== "account") return { ok: false };
  const store = createStore(getJobchatSql());
  await store.deleteProfile(identity.userId);
  if (conversationId) {
    const owner = await store.getConversationOwner(conversationId);
    if (owner && owner.user_id === identity.userId) {
      await store.deleteMessage(conversationId, profileCardMessageId(conversationId));
    }
  }
  return { ok: true };
}

// Trigger run statuses that are TERMINAL failures; others are in-flight, COMPLETED is terminal success.
const TERMINAL_FAILURE_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "CANCELED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
  "PARTIAL_FAILED",
]);

/** The extraction run's terminal state - the poll's re-save-edge backstop: a re-extraction over an existing
 *  profile flips no marker, so getMyProfile alone would poll forever; a transient error reads as pending. */
export async function getProfileRunStatus(
  runId: string,
): Promise<{ status: "pending" | "done" | "failed" }> {
  try {
    const run = await runs.retrieve(runId);
    if (run.status === "COMPLETED") return { status: "done" };
    if (TERMINAL_FAILURE_STATUSES.has(run.status)) return { status: "failed" };
    return { status: "pending" };
  } catch {
    return { status: "pending" };
  }
}
