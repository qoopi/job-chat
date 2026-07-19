"use server";

import { cookies } from "next/headers";
import postgres, { type Sql } from "postgres";
import { auth, sessions } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { createStore } from "@shared/store";
import { getGuardConfig } from "@shared/env";
import { isE2E } from "@/lib/e2e";
import { AGENT_ID } from "../../trigger/agent-id";
import {
  chatTokenScopes,
  createSessionService,
  type MintResult,
  type MintToken,
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
  return service().startConversation(guestId, question);
}

/** Follow-up send: input-bounded, ownership-checked, cap (AC-15) + daily-budget (AC-20) guarded. */
export async function sendMessage(conversationId: string, text: string): Promise<SessionResult> {
  const guestId = await guestIdFromCookie();
  if (!guestId) return { ok: false, reason: "not_found" };
  return service().sendMessage(conversationId, text, guestId);
}

/**
 * Re-mint a session-scoped public token for the transport to reconnect - but only for the caller's
 * OWN conversation (typed `not_found` otherwise, so one guest's token never grants another's session).
 */
export async function mintChatToken(conversationId: string): Promise<MintResult> {
  const guestId = await guestIdFromCookie();
  if (!guestId) return { ok: false, reason: "not_found" };
  return service().mintChatToken(conversationId, guestId);
}
