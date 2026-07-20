"use server";

import { cookies, headers } from "next/headers";
import postgres, { type Sql } from "postgres";
import { auth, sessions } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { createStore, type Conversation } from "@shared/store";
import { getGuardConfig } from "@shared/env";
import { isE2E } from "@/lib/e2e";
import { auth as authServer } from "@/lib/auth";
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
  type SendToInbox,
  type SessionResult,
  type StartSession,
} from "../../trigger/session";
import type { jobChatAgent } from "../../trigger/chat";

// The session server actions: the thin Next.js adapter over the injectable session core
// (trigger/session.ts). They resolve the guest cookie + real store/trigger and delegate the guard +
// handoff decisions. Business outcomes come back as typed SessionResult/MintResult - no throws (the
// UI branches on `reason`). This file holds ONLY async server actions (the "use server" contract);
// all wiring is module-private.

const GUEST_COOKIE = "jobchat_guest";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// One lazy Postgres pool for the server process (no connection until first query).
let sqlSingleton: Sql | undefined;
function sql(): Sql {
  return (sqlSingleton ??= postgres(process.env.DATABASE_URL!));
}

// Start (or resume) the durable session and mint its browser token, server-side so the secret key
// never reaches the browser. `mintToken` is the re-mint the transport reconnects with; both are
// gated by the session core's ownership check.
const startSessionAction = chat.createStartSessionAction<typeof jobChatAgent>(AGENT_ID);
const startSession: StartSession = async ({ chatId }) => {
  const r = await startSessionAction({ chatId });
  return { publicAccessToken: r.publicAccessToken, runId: r.runId, sessionId: r.sessionId };
};
const mintToken: MintToken = (conversationId) =>
  auth.createPublicToken({ scopes: chatTokenScopes(conversationId), expirationTime: "1h" });

// Deliver the user turn to the durable session inbox after the run is triggered. This is the only
// server-side writer of `.in`; the preloaded agent run waits here for its first message (the browser
// transport never sends one in our server-mediated flow). The session-scoped secret-key client
// addresses the session by its externalId (= our conversation id).
const sendToInbox: SendToInbox = (chatId, chunk) => sessions.open(chatId).in.send(chunk);

function service() {
  return createSessionService({
    store: createStore(sql()),
    guards: getGuardConfig(),
    startSession,
    mintToken,
    sendToInbox,
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
async function currentAuthUser(): Promise<{ id: string; name?: string } | undefined> {
  if (isE2E()) return undefined;
  try {
    const session = await authServer.api.getSession({ headers: await headers() });
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

/** AC-12: first visit mints an httpOnly cookie guest id with a users row; returns the guest id. */
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
  // E2E has no Postgres: the cookie is the AC-12 slice under test; the users-row half is covered by the
  // store/session integration tests against real PG.
  if (isE2E()) return guestId;
  await createStore(sql()).getOrCreateUser(guestId);
  return guestId;
}

/** AC-3 landing handoff: create the conversation + user message #1 and trigger the run. */
export async function startConversation(question: string): Promise<SessionResult> {
  const guestId = await ensureGuest();
  const authUserId = await currentAuthUserId();
  const identity = await resolveIdentity(createStore(sql()), { authUserId, guestId });
  return service().startConversation(identity.userId, question, identity.kind);
}

/**
 * Follow-up send GATE (mechanism a): input-bounded, ownership-checked, cap (AC-15) + daily-budget
 * (AC-20) guarded, and returns the scoped token the client transport attaches with. It does NOT persist
 * or trigger - the transport's `sendMessages` delivers the turn to `.in` (triggering the run) and
 * subscribes with wait (the only SDK path that streams a freshly-triggered follow-up live), and the
 * agent's `run()` persists the user turn before the backstop counts it.
 */
export async function sendMessage(conversationId: string, text: string): Promise<SendResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().sendMessage(conversationId, text, identity.userId, identity.kind);
}

/**
 * Re-mint a session-scoped public token for the transport to reconnect - but only for the caller's
 * OWN conversation (typed `not_found` otherwise, so one guest's token never grants another's session).
 */
export async function mintChatToken(conversationId: string): Promise<MintResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().mintChatToken(conversationId, identity.userId);
}

/**
 * The sign-in TRANSITION (AC-11, decision-log ruling): called by the client the moment an in-page
 * sign-in succeeds. Binds the fresh Better Auth session to the chat identity - `resolveIdentity` adopts
 * the guest's conversations onto the account (idempotent, guarded at the store) - then clears the guest
 * cookie so the per-request path stops seeing it and never re-adopts. A no-op when no verified session
 * exists yet (or E2E). Adoption is bound to THIS transition, not to per-request resolution.
 */
export async function completeSignIn(): Promise<{ ok: boolean; name?: string }> {
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
 * AC-12 (UI slice): the signed-in caller's conversations, newest first, for the sidebar history. The
 * client refetches this after an in-page sign-in (the initial list is server-rendered by the chat
 * page). Empty for a caller that owns nothing.
 */
export async function listMyConversations(): Promise<
  Pick<Conversation, "id" | "title" | "created_at">[]
> {
  const identity = await resolveCaller();
  if (!identity) return [];
  return createStore(sql()).listConversations(identity.userId);
}

/**
 * AC-21: delete one of the caller's OWN conversations (messages cascade). Ownership is enforced here in
 * the action via the resolved Identity + the session core's owner check - a non-owner (or a caller that
 * owns nothing) reads as not_found, never deleting another user's thread.
 */
export async function deleteConversation(conversationId: string): Promise<DeleteResult> {
  const identity = await resolveCaller();
  if (!identity) return { ok: false, reason: "not_found" };
  return service().deleteConversation(conversationId, identity.userId);
}
