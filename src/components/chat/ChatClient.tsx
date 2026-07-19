"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { Composer, type ComposerState } from "./Composer";
import { MessageList } from "./MessageList";
import { useJobChatTransport } from "@/lib/chat-transport";
import { isStreaming } from "@/lib/chat-ui";
import { sendMessage as sendMessageAction } from "@/app/actions";

// The live chat surface (mock 2a): it swaps 005's static fixture for `useChat` message parts fed by the
// Trigger transport, and wires every interaction the interaction-spec calls for - composer send / stop
// (AC-8/9), follow-up chips one-shot (AC-7), error retry (AC-10), and the polite limit notice (AC-15).
//
// Send paths differ by boundary, not by rendering:
//  - PROD: the `sendMessage` server action persists the user turn to Postgres BEFORE the run counts it
//    (the guard/AC-13 handoff) and returns the early typed refusal (UX); the run then streams over the
//    transport, which we attach to with `resumeStream`. A cap/budget refusal is rendered as a
//    data-refusal part so it reads identically to the agent-side backstop's refusal.
//  - E2E: the mock transport streams a scripted answer, so `useChat.sendMessage` drives the whole turn
//    with no Trigger/Bedrock. The rendering, reconciliation, and controls under test are the same.

function makeUserMessage(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}

export function ChatClient({
  conversationId,
  title,
  initialMessages,
  pendingQuestion,
  autoStream = false,
  e2e = false,
}: {
  conversationId: string;
  title?: string;
  initialMessages: UIMessage[];
  pendingQuestion?: string;
  autoStream?: boolean;
  e2e?: boolean;
}) {
  const transport = useJobChatTransport({ e2e });
  const { messages, sendMessage, stop, status, regenerate, setMessages, resumeStream } = useChat({
    id: conversationId,
    transport,
    messages: initialMessages,
  });

  const [draft, setDraft] = useState("");
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const started = useRef(false);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setFailed(null);

      if (e2e) {
        void sendMessage({ text });
        return;
      }

      try {
        const r = await sendMessageAction(conversationId, text);
        if (!r.ok) {
          if (r.reason === "guest_cap" || r.reason === "daily_budget") {
            // Same polite notice as the agent-side backstop: append a data-refusal turn so the one
            // MessageList path renders it (decision 19 / 004 handoff), not a bespoke banner.
            setMessages((prev) => [
              ...prev,
              makeUserMessage(text),
              { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "data-refusal", data: { reason: r.reason } }] } as UIMessage,
            ]);
            return;
          }
          setFailed(text); // invalid_input / not_found -> send-failure toast
          setDraft(text); // draft preserved (interaction-spec section 4)
          return;
        }
        // Optimistically show the user turn, then attach to the run the action just triggered.
        setMessages((prev) => [...prev, makeUserMessage(text)]);
        await resumeStream();
      } catch {
        setFailed(text);
        setDraft(text);
      }
    },
    [e2e, conversationId, sendMessage, setMessages, resumeStream],
  );

  // AC-3 arrival: the landing question is already answered on this screen. E2E streams it via the mock
  // send; prod attaches to the run the landing action already triggered. Runs exactly once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Deferred off the effect body: the arrival kick sets state (optimistic turn / stream attach) and
    // must not run synchronously during the mount effect (cascading-render rule).
    queueMicrotask(() => {
      if (e2e && pendingQuestion) void send(pendingQuestion);
      else if (!e2e && autoStream) void resumeStream();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFollowup = useCallback(
    (cardId: string, text: string) => {
      // AC-7: one-shot - mark this card's chip used (stays disabled) and send its text as the next turn.
      setUsed((prev) => new Set(prev).add(`${cardId}::${text}`));
      void send(text);
    },
    [send],
  );

  const onComposerSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void send(text);
  }, [draft, send]);

  const composerState: ComposerState = isStreaming(status) ? "streaming" : "default";

  return (
    <div className="app" style={{ height: "100vh" }}>
      <Sidebar activeTitle={title} />
      <main className="main">
        <div className="canvas">
          <TitleBar title={title} />
          <div className="thread-scroll">
            <MessageList
              messages={messages}
              status={status}
              usedFollowups={used}
              onFollowup={onFollowup}
              onRetry={() => void regenerate()}
            />
          </div>
          <Composer
            state={composerState}
            value={draft}
            onChange={setDraft}
            onSend={onComposerSend}
            onStop={() => void stop()}
          />
        </div>
      </main>
      {failed ? (
        // Send-failure toast, bottom-center with Retry (interaction-spec section 4). No design token
        // exists for a toast (005 did not ship one), so it is styled inline from theme variables.
        <div
          role="alert"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-md)",
            fontSize: "var(--fs-sm)",
            color: "var(--text)",
            zIndex: 50,
          }}
        >
          <span>Could not send - check your connection.</span>
          <button
            className="btn btn-outline btn-sm"
            type="button"
            onClick={() => {
              const text = failed;
              setFailed(null);
              void send(text);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
