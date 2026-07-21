"use client";

import { useMemo, useState } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { AGENT_ID } from "../../trigger/agent-id";
import { mintChatToken } from "@/app/actions";
import { MockChatTransport } from "./mock-transport";
import { readPersistedSession, writePersistedSession } from "./chat-session-store";
import type { jobChatAgent } from "../../trigger/chat";

// The transport surface ChatClient drives: the standard `ChatTransport` plus `setSession` - the arrival
// attach hydrates a freshly-minted token + `isStreaming` so `reconnectToStream` (via
// `useChat.resumeStream`) resumes the just-triggered run instead of returning null on a fresh mount
// (006 P0; 024 deletes arrival-attach). The follow-up send no longer threads session state - the
// transport owns the `.out` cursor and refreshes its token via `accessToken` on 401 (F1/F7). Both the
// real transport and the E2E mock implement it.
export interface JobChatTransport extends ChatTransport<UIMessage> {
  setSession(
    chatId: string,
    session: { publicAccessToken: string; isStreaming?: boolean; lastEventId?: string },
  ): void;
}

// The transport seam. Production: the standard Trigger.dev chat transport (skill-endorsed, unchanged) -
// it mints a session-scoped token from our ownership-checked `mintChatToken` action and streams the
// durable run's `.out`. E2E: a scripted mock so the client loop runs with no Trigger/Bedrock. Both
// hooks are called unconditionally (React rules) - the unused one does no I/O until driven, so shipping
// the mock into the bundle is inert in production. `import type { jobChatAgent }` is erased at build, so
// no server code (postgres, ClickHouse) leaks into the client.
export function useJobChatTransport({
  e2e,
  conversationId,
}: {
  e2e: boolean;
  conversationId: string;
}): JobChatTransport {
  const mock = useMemo(() => new MockChatTransport(), []);
  // Hydrate this conversation's persisted session at transport construction (the SDK reads `sessions`
  // once, on first render). A settled entry makes `reconnectToStream` no-op; a live one lets it resume
  // from the persisted `.out` cursor. Read once (SSR-guarded) - the transport ignores later changes.
  const [hydrated] = useState(() => {
    const s = readPersistedSession(conversationId);
    return s ? { [conversationId]: s } : undefined;
  });
  const real = useTriggerChatTransport<typeof jobChatAgent>({
    task: AGENT_ID,
    accessToken: async ({ chatId }) => {
      const r = await mintChatToken(chatId);
      if (!r.ok) throw new Error("chat session unavailable");
      return r.token;
    },
    sessions: hydrated,
    // Persist every session change (token refresh, cursor advance, stream start/stop) so the next mount
    // resumes exactly where this one left off; a null clears the stored key when the session closes.
    onSessionChange: writePersistedSession,
  });
  return e2e ? mock : real;
}
