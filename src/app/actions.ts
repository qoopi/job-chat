"use server";

import { cookies, headers } from "next/headers";
import postgres, { type Sql } from "postgres";
import { auth, tasks } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { createStore, type ConversationSummary } from "@shared/store";
import type { Profile } from "@shared/profile";
import type { extractProfileTask } from "../../trigger/extract-profile";
import { getGuardConfig } from "@shared/env";
import { isE2E } from "@/lib/e2e";
import { auth as authServer } from "@/lib/auth";
import { GUEST_COOKIE } from "@/lib/guest-cookie";
import { AGENT_ID } from "../../trigger/agent-id";
import {
  chatTokenScopes,
  createSessionService,
  resolveIdentity,
  type DeleteResult,
  type Identity,
  type MintResult,
  type MintToken,
  type SendResult,
  type SessionResult,
} from "../../trigger/session";
import type { jobChatAgent } from "../../trigger/chat";

// The session server actions: the thin Next.js adapter over the injectable session core
// (trigger/session.ts). They resolve the guest cookie + real store/trigger and delegate the guard +
// handoff decisions. Business outcomes come back as typed SessionResult/MintResult - no throws (the
// UI branches on `reason`). This file holds ONLY async server actions (the "use server" contract);
// all wiring is module-private.

const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// One lazy Postgres pool cached on globalThis (shared key with server-store.ts) so Next.js dev HMR
// reuses ONE client instead of leaking a fresh pool per module reload (which exhausts the Managed
// Postgres connection limit -> intermittent CONNECT_TIMEOUT / read ETIMEDOUT). See auth.ts.
const globalForSql = globalThis as unknown as { __jobchatSql?: Sql };
function sql(): Sql {
  return (globalForSql.__jobchatSql ??= postgres(process.env.DATABASE_URL!));
}

// The transport's `startSession` action (createStartSessionAction): the "use client" chat transport
// calls it lazily on the first `sendMessage` for a chatId with no cached session - it atomically creates
// the Session row, triggers the first run, and returns the browser's session-scoped token. This is THE
// turn-1 delivery seam (the documented path), so turn 1 rides the same public send path as every
// follow-up. Idempotent on (env, externalId). Exported for chat-transport.ts's `startSession` option.
export const startChatSession = chat.createStartSessionAction<typeof jobChatAgent>(AGENT_ID);

// The re-mint the transport reconnects with (its `accessToken` callback), server-side so the secret key
// never reaches the browser; gated by the session core's ownership check on the surrounding action.
const mintToken: MintToken = (conversationId) =>
  auth.createPublicToken({
    scopes: chatTokenScopes(conversationId),
    expirationTime: "1h",
  });

function service() {
  return createSessionService({
    store: createStore(sql()),
    guards: getGuardConfig(),
    mintToken,
    now: () => new Date(),
  });
}

/**
 * Read the guest cookie WITHOUT the `getOrCreateUser` upsert - for actions where the caller must
 * already exist (a follow-up send / a token re-mint on an owned conversation). No cookie means the
 * caller owns nothing, so the action's ownership check would refuse anyway; we short-circuit to the
 * same `not_found` and skip both a wasted cookie mint and a redundant users-row write. The upsert
 * stays on `ensureGuest` (the first-contact / landing path that also mints the cookie).
 */
async function guestIdFromCookie(): Promise<string | undefined> {
  return (await cookies()).get(GUEST_COOKIE)?.value;
}

/**
 * The signed-in Better Auth user (id + display name), or undefined for a guest. Auth is lazy and
 * additive: a read failure (misconfig / no session) degrades to guest - it must never break the
 * guest-open chat. E2E runs without auth (no Postgres), so short-circuit it.
 */
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

/** The signed-in Better Auth user id, or undefined for a guest (the common case; see currentAuthUser). */
async function currentAuthUserId(): Promise<string | undefined> {
  return (await currentAuthUser())?.id;
}

/**
 * Resolve the caller's chat Identity for a follow-up action (send / re-mint): the guest cookie plus
 * any verified Better Auth session, reconciled (adoption) by `resolveIdentity`. `null` when the caller
 * presents neither - the action refuses as `not_found` (a caller that owns nothing). One home so the
 * two follow-up actions can never drift.
 */
async function resolveCaller(): Promise<Identity | null> {
  const guestId = await guestIdFromCookie();
  const authUserId = await currentAuthUserId();
  if (!guestId && !authUserId) return null;
  return resolveIdentity(createStore(sql()), { authUserId, guestId });
}

/**
 * First visit mints an httpOnly cookie guest id with a users row; returns the guest id.
 * NOTE: the guest id is an UNSIGNED bearer cookie (forgeable). Hardening (signing / the Better Auth
 * anonymous plugin) is an accepted residual for the hackathon.
 */
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
  // E2E has no Postgres: the cookie is the slice under test; the users-row half is covered by the
  // store/session integration tests against real PG.
  if (isE2E()) return guestId;
  await createStore(sql()).getOrCreateUser(guestId);
  return guestId;
}

/** Landing handoff: create the conversation + persist user message #1, return its id. Turn 1 is
 *  delivered on the client's public send path (no server-side trigger). */
export async function startConversation(
  question: string,
): Promise<SessionResult> {
  const guestId = await ensureGuest();
  const authUserId = await currentAuthUserId();
  const identity = await resolveIdentity(createStore(sql()), {
    authUserId,
    guestId,
  });
  return service().startConversation(identity.userId, question, identity.kind);
}

/**
 * Follow-up send GATE: input-bounded, ownership-checked, cap + daily-budget
 * guarded. A pure gate - it does NOT persist, trigger, or mint. The client transport's
 * `sendMessages` delivers the turn to `.in` (triggering the run) and subscribes with wait (the only SDK
 * path that streams a freshly-triggered follow-up live), refreshing its token via the `accessToken`
 * callback; the agent's `run()` persists the user turn before the backstop counts it.
 */
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

/**
 * Re-mint a session-scoped public token for the transport to reconnect - but only for the caller's
 * OWN conversation (typed `not_found` otherwise, so one guest's token never grants another's session).
 */
export async function mintChatToken(
  conversationId: string,
): Promise<MintResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().mintChatToken(conversationId, identity.userId);
}

/**
 * The sign-in TRANSITION: called by the client the moment an in-page
 * sign-in succeeds. Binds the fresh Better Auth session to the chat identity - `resolveIdentity` adopts
 * the guest's conversations onto the account (idempotent, guarded at the store) - then clears the guest
 * cookie so the per-request path stops seeing it and never re-adopts. A no-op when no verified session
 * exists yet (or E2E). Adoption is bound to THIS transition, not to per-request resolution.
 */
export async function completeSignIn(): Promise<{
  ok: boolean;
  name?: string;
}> {
  const user = await currentAuthUser();
  if (!user) return { ok: false };
  const guestId = await guestIdFromCookie();
  await resolveIdentity(createStore(sql()), { authUserId: user.id, guestId });
  // Delete with the SAME path the cookie was SET with (ensureGuest uses `path:"/"`); a name-only delete
  // whose Set-Cookie path does not match can leave the browser cookie in place.
  if (guestId) (await cookies()).delete({ name: GUEST_COOKIE, path: "/" });
  // The account's display name lets the client refresh the sidebar foot without a full reload.
  return { ok: true, name: user.name };
}

/**
 * Sign-out companion: drop the guest cookie so a signed-out user does NOT resume a stale guest
 * thread. On the Google sign-in path the cookie was already cleared (completeSignIn) - this is the
 * defensive rotation for sign-out; the landing's `ensureGuest` mints a fresh guest identity next visit.
 */
export async function clearGuestSession(): Promise<void> {
  (await cookies()).delete({ name: GUEST_COOKIE, path: "/" });
}

/**
 * The signed-in caller's conversations, newest first, for the sidebar history. The
 * client refetches this after an in-page sign-in (the initial list is server-rendered by the chat
 * page). Empty for a caller that owns nothing.
 */
export async function listMyConversations(): Promise<ConversationSummary[]> {
  const identity = await resolveCaller();
  if (!identity) return [];
  return createStore(sql()).listConversations(identity.userId);
}

/**
 * Delete one of the caller's OWN conversations (messages cascade). Ownership is enforced here in
 * the action via the resolved Identity + the session core's owner check - a non-owner (or a caller that
 * owns nothing) reads as not_found, never deleting another user's thread.
 */
export async function deleteConversation(
  conversationId: string,
): Promise<DeleteResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().deleteConversation(conversationId, identity.userId);
}

// The server cap on the DECODED resume PDF (the form caps ~4MB; a hair over is allowed so a legit ~4MB
// file is never rejected by a stricter server bound). next.config raises the Server Action body limit to
// 6mb to fit the base64-inflated payload before it reaches here.
const MAX_RESUME_PDF_BYTES = Math.floor(4.5 * 1024 * 1024);

/** The signed-in job seeker's own profile (sanitized - never the transient PDF bytes), for the LCP poll
 *  read: the structured profile (null while extraction is pending), the github username, and the
 *  extraction timestamp (null = pending; the panel polls until it advances). */
export interface MyProfile {
  profile: Profile | null;
  githubUsername: string | null;
  extractedAt: string | null;
}

export type SaveProfileInput = {
  conversationId: string;
  resumeText?: string;
  resumePdf?: { bytes: string; name: string };
  githubUsername?: string;
};

export type SaveProfileResult =
  | { ok: true; taskState: "queued"; runId: string }
  | { ok: false; reason: "unauthorized" | "too-large" | "empty" };

function trimmedOrNull(value: string | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

/**
 * Store the profile inputs and kick off background extraction. Signed-in only (profiles exist only on
 * accounts - auth-first) AND the conversation must be the caller's OWN (a forged conversation id can
 * never append a card to someone else's thread). The resume PDF (base64) is decoded, size-capped, and
 * staged transiently; then the extract-profile Trigger task runs the GitHub fetch + the model extraction.
 * Returns the queued task state - the panel polls `getMyProfile` until `extractedAt` advances.
 */
export async function saveProfile(
  input: SaveProfileInput,
): Promise<SaveProfileResult> {
  const identity = await resolveCaller();
  if (!identity || identity.kind !== "account") {
    return { ok: false, reason: "unauthorized" };
  }
  const store = createStore(sql());
  // Ownership: the target conversation must belong to the signed-in caller.
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

  const handle = await tasks.trigger<typeof extractProfileTask>("extract-profile", {
    userId: identity.userId,
    conversationId: input.conversationId,
  });
  return { ok: true, taskState: "queued", runId: handle.id };
}

/** The LCP poll read: the caller's own profile, sanitized. `null` for a guest or a caller with no
 *  profile row yet (the AC-2 invite path). */
export async function getMyProfile(): Promise<MyProfile | null> {
  const identity = await resolveCaller();
  if (!identity || identity.kind !== "account") return null;
  const row = await createStore(sql()).getProfile(identity.userId);
  if (!row) return null;
  return {
    profile: row.profile,
    githubUsername: row.github_username,
    extractedAt: row.extracted_at ? row.extracted_at.toISOString() : null,
  };
}

/** Delete the signed-in caller's profile (raw inputs + structured profile). Idempotent; subsequent
 *  fit-intents then behave as the no-profile path (AC-10). */
export async function deleteProfile(): Promise<{ ok: boolean }> {
  const identity = await resolveCaller();
  if (!identity || identity.kind !== "account") return { ok: false };
  await createStore(sql()).deleteProfile(identity.userId);
  return { ok: true };
}
