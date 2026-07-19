"use server";

import { cookies } from "next/headers";
import postgres, { type Sql } from "postgres";
import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { createStore } from "@shared/store";
import { getGuardConfig } from "@shared/env";
import { createSessionService, type SessionResult, type StartSession } from "../../trigger/session";
import type { jobChatAgent } from "../../trigger/chat";

// The session server actions: the thin Next.js adapter over the injectable session core
// (trigger/session.ts). They resolve the guest cookie + real store/trigger and delegate the guard +
// handoff decisions. Business outcomes come back as typed SessionResult - no throws (the UI branches
// on `reason`). This file holds ONLY async server actions (the "use server" contract); all wiring is
// module-private.

const AGENT_ID = "job-chat-agent";
const GUEST_COOKIE = "jobchat_guest";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// One lazy Postgres pool for the server process (no connection until first query).
let sqlSingleton: Sql | undefined;
function sql(): Sql {
  return (sqlSingleton ??= postgres(process.env.DATABASE_URL!));
}

// Session-scoped read+write token for the conversation, minted server-side so the secret key never
// reaches the browser. Also returned by startSession on create; this is the re-mint for reconnects.
const startSessionAction = chat.createStartSessionAction<typeof jobChatAgent>(AGENT_ID);
const startSession: StartSession = async ({ chatId }) => {
  const r = await startSessionAction({ chatId });
  return { publicAccessToken: r.publicAccessToken, runId: r.runId, sessionId: r.sessionId };
};

function service() {
  return createSessionService({
    store: createStore(sql()),
    guards: getGuardConfig(),
    startSession,
    now: () => new Date(),
  });
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
  await createStore(sql()).getOrCreateUser(guestId);
  return guestId;
}

/** AC-3 landing handoff: create the conversation + user message #1 and trigger the run. */
export async function startConversation(question: string): Promise<SessionResult> {
  const guestId = await ensureGuest();
  return service().startConversation(guestId, question);
}

/** Follow-up send with the cap (AC-15) + daily-budget (AC-20) guards enforced before triggering. */
export async function sendMessage(conversationId: string, text: string): Promise<SessionResult> {
  await ensureGuest();
  return service().sendMessage(conversationId, text);
}

/** Re-mint a session-scoped public token for the transport to reconnect to this conversation. */
export async function mintChatToken(conversationId: string): Promise<string> {
  return auth.createPublicToken({
    scopes: { read: { sessions: conversationId }, write: { sessions: conversationId } },
    expirationTime: "1h",
  });
}
