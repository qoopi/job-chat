"use client";

import { useMemo, useState } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { AGENT_ID } from "../../trigger/agent-id";
import { mintChatToken, startChatSession } from "@/app/actions";
import { MockChatTransport } from "./mock-transport";
import { readPersistedSession, writePersistedSession } from "./chat-session-store";
import type { jobChatAgent } from "../../trigger/chat";

// The transport surface ChatClient drives: the standard `ChatTransport` plus `stopGeneration`. Session
// state is owned entirely by the transport now - hydrated at construction from the persisted session
// (`sessions`), refreshed via the `accessToken` callback on 401, and lazily started on the first send
// (`startSession`). There is no imperative `setSession` seam. Both the real transport and the E2E mock
// implement this.
export interface JobChatTransport extends ChatTransport<UIMessage> {
  // Stop must reach the backend after a RESUMED mount: `useChat.stop()` aborts only the local reader
  // (the AI SDK does not thread an abort through `reconnectToStream`), so the composer's onStop pairs it
  // with `stopGeneration`, which posts `{kind:"stop"}` on `.in` and halts the agent's streamText.
  stopGeneration(chatId: string): Promise<boolean>;
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
  // Hydrate this conversation's persisted session at transport construction (the SDK reads `sessions`
  // once, on first render). A settled entry makes `reconnectToStream` no-op; a live one lets it resume
  // from the persisted `.out` cursor. Read once (SSR-guarded) - the transport ignores later changes.
  const [hydrated] = useState(() => {
    const s = readPersistedSession(conversationId);
    return s ? { [conversationId]: s } : undefined;
  });
  const mock = useMemo(() => new MockChatTransport(hydrated), [hydrated]);
  const real = useTriggerChatTransport<typeof jobChatAgent>({
    task: AGENT_ID,
    accessToken: async ({ chatId }) => {
      const r = await mintChatToken(chatId);
      if (!r.ok) throw new Error("chat session unavailable");
      return r.token;
    },
    // Lazily start (or resume) the session on the first `sendMessage` for a chatId with no cached
    // session - THE documented turn-1 delivery path (createStartSessionAction creates the Session +
    // triggers the run + returns the browser token). Every follow-up reuses the cached session.
    startSession: ({ chatId }) => startChatSession({ chatId }),
    sessions: hydrated,
    // Persist every session change (token refresh, cursor advance, stream start/stop) so the next mount
    // resumes exactly where this one left off; a null clears the stored key when the session closes.
    onSessionChange: writePersistedSession,
  });
  return e2e ? mock : real;
}
