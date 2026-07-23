"use client";

import { useMemo, useState } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { AGENT_ID } from "../../trigger/agent-id";
import { mintChatToken, startChatSession } from "@/app/actions";
import { MockChatTransport } from "@/lib/e2e-transport";
import { readPersistedSession, writePersistedSession } from "./chat-session-store";
import type { jobChatAgent } from "../../trigger/chat";

// The transport surface (ChatTransport + stopGeneration + preload); session state is owned by the transport (hydrated, token-refreshed on 401, lazily started).
export interface JobChatTransport extends ChatTransport<UIMessage> {
  // Stop must reach the backend after a RESUMED mount: `useChat.stop()` aborts only the local reader, so onStop pairs it with `stopGeneration` ({kind:"stop"} on `.in`).
  stopGeneration(chatId: string): Promise<boolean>;
  // Cold-start warm: eagerly create the session + boot its run for a chatId BEFORE the first
  // send, so the ~cold agent boot overlaps mount/typing instead of stacking after the send. The real
  // transport runs `startSession` (createStartSessionAction) - a Trigger session only, NEVER a PG row.
  // Optional: the e2e mock owns no real session, so there is nothing to warm and it simply omits it.
  preload?(chatId: string): Promise<void>;
}

// Transport seam. Prod: the Trigger.dev transport (token via our ownership-checked `mintChatToken`). E2E: a scripted mock, CONSTRUCTED only under the e2e flag - no test/server code ships to the client.
export function useJobChatTransport({
  e2e,
  conversationId,
}: {
  e2e: boolean;
  conversationId: string;
}): JobChatTransport {
  // Hydrate the persisted session at construction (SDK reads `sessions` once); a settled entry no-ops reconnect, a live one resumes from the cursor.
  const [hydrated] = useState(() => {
    const s = readPersistedSession(conversationId);
    return s ? { [conversationId]: s } : undefined;
  });
  const mock = useMemo(
    () => (e2e ? new MockChatTransport(hydrated) : null),
    [e2e, hydrated],
  );
  const real = useTriggerChatTransport<typeof jobChatAgent>({
    task: AGENT_ID,
    // BroadcastChannel two-tab guard: one tab claims the chatId, others go read-only (no double-send).
    multiTab: true,
    accessToken: async ({ chatId }) => {
      const r = await mintChatToken(chatId);
      if (!r.ok) throw new Error("chat session unavailable");
      return r.token;
    },
    // Lazily start/resume the session on the first `sendMessage` - the turn-1 delivery path; follow-ups reuse the cached session.
    startSession: ({ chatId }) => startChatSession({ chatId }),
    sessions: hydrated,
    onSessionChange: writePersistedSession,
  });
  return e2e && mock ? mock : real;
}
