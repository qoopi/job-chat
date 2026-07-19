"use client";

import { useMemo } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { AGENT_ID } from "../../trigger/agent-id";
import { mintChatToken } from "@/app/actions";
import { MockChatTransport } from "./mock-transport";
import type { jobChatAgent } from "../../trigger/chat";

// The transport surface ChatClient drives: the standard `ChatTransport` plus `setSession`, the SDK hook
// through which a server-minted session token + `isStreaming` are threaded into the transport's session
// cache. That hydration is what makes `reconnectToStream` (via `useChat.resumeStream`) subscribe instead
// of returning null on a fresh mount (006 P0). Both the real transport and the E2E mock implement it.
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
export function useJobChatTransport({ e2e }: { e2e: boolean }): JobChatTransport {
  const mock = useMemo(() => new MockChatTransport(), []);
  const real = useTriggerChatTransport<typeof jobChatAgent>({
    task: AGENT_ID,
    accessToken: async ({ chatId }) => {
      const r = await mintChatToken(chatId);
      if (!r.ok) throw new Error("chat session unavailable");
      return r.token;
    },
  });
  return e2e ? mock : real;
}
