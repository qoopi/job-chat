"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { Composer, type ComposerState } from "./Composer";
import { MessageList } from "./MessageList";
import { useJobChatTransport } from "@/lib/chat-transport";
import { isStreaming, reconcileMessagesById } from "@/lib/chat-ui";
import { mintChatToken, sendMessage as sendMessageAction } from "@/app/actions";

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
  // Instant "answering" feedback (006 ruling): set the moment a turn is sent or the arrival attach
  // begins, so the indicator + streaming composer appear AT ONCE and bridge the run-wake gap before the
  // SDK moves `status` off "ready". `pending` is `isStreaming(status) || awaiting`, so once the stream is
  // live `status` dominates; the send/attach `finally` clears the flag when the await chain settles
  // (stream end, Stop-abort, refusal, invalid, or a no-op reconnect), never leaving it stuck.
  const [awaiting, setAwaiting] = useState(false);
  const started = useRef(false);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setFailed(null);
      setAwaiting(true); // instant answering indicator + streaming composer through the run-wake gap

      try {
        if (e2e) {
          // Mock transport streams the scripted turn; a Stop-abort rejects here and is expected (no toast).
          try {
            await sendMessage({ text });
          } catch {
            /* stream aborted (Stop) or mock stream error - e2e only, no send-failure toast */
          }
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
          // Hydrate the transport with the action's scoped token, then DELIVER + WATCH the turn via the
          // transport's `sendMessages` (`useChat.sendMessage`). That one primitive appends the turn to
          // `.in` (which triggers the run) AND subscribes with wait - the only SDK 4.5.4 path that streams
          // a freshly-triggered follow-up live. `resumeStream`/`reconnectToStream` forces peekSettled,
          // built for reload-resume: attaching to a run triggered milliseconds earlier it reads the
          // settled prior turn and never delivers the fresh chunks (006 diagnosis, routed to 004).
          // `useChat.sendMessage` adds the optimistic user turn itself, so no manual setMessages here.
          //
          // Carry the prior turn's `.out` cursor forward. `sendMessages` subscribes with
          // `lastEventId: state.lastEventId` (SDK 4.5.4 chat.js); `setSession` REPLACES the cached session,
          // so passing it without `lastEventId` would WIPE the cursor and the follow-up subscribe would
          // replay the session `.out` log from the START - re-delivering the prior turn's chunks, which the
          // AI SDK cannot reconcile by id (they accumulate into the one new streaming message: 006 live
          // artifact). Threading the tracked cursor resumes AFTER the prior turn, so only this turn streams.
          const prior = transport.getSession(conversationId);
          transport.setSession(conversationId, {
            publicAccessToken: r.publicAccessToken,
            isStreaming: true,
            lastEventId: prior?.lastEventId,
          });
          await sendMessage({ text });
        } catch {
          setFailed(text);
          setDraft(text);
        }
      } finally {
        setAwaiting(false); // fallback clear for paths that never stream (refusal / invalid / abort)
      }
    },
    [e2e, conversationId, sendMessage, setMessages, transport],
  );

  // AC-3 arrival attach: the landing action already created the conversation and triggered its run, but
  // the run's token was discarded on the redirect. Mint a fresh session-scoped token (ownership-checked)
  // and hydrate the transport so resumeStream subscribes to the in-flight run instead of no-op'ing on an
  // empty session cache (006 P0). Prod only - E2E arrival streams via the mock's mount-time send.
  const attachOnArrival = useCallback(async () => {
    setAwaiting(true); // indicator shows AT ONCE on arrival, through the mint + attach gap (server bubble already present)
    try {
      const r = await mintChatToken(conversationId);
      if (!r.ok) return;
      transport.setSession(conversationId, { publicAccessToken: r.token, isStreaming: true });
      await resumeStream();
    } finally {
      setAwaiting(false);
    }
  }, [conversationId, transport, resumeStream]);

  // AC-3 arrival: the landing question is already answered on this screen. E2E streams it via the mock
  // send; prod attaches to the run the landing action already triggered. Runs exactly once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Deferred off the effect body: the arrival kick sets state (optimistic turn / stream attach) and
    // must not run synchronously during the mount effect (cascading-render rule).
    queueMicrotask(() => {
      if (e2e && pendingQuestion) void send(pendingQuestion);
      else if (!e2e && autoStream) void attachOnArrival();
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

  // Ref-stable so `React.memo(AssistantMessage)` can bail on settled turns: an inline lambda here would
  // be a fresh ref every ChatClient render and defeat the memo (regenerate is stable across renders).
  const onRetry = useCallback(() => void regenerate(), [regenerate]);

  // Reconcile by id at the merge seam: a hydrated conversation that reconnects to a live run re-receives
  // its already-present assistant tail from the SDK's session replay, which the AI SDK appends under the
  // same id. Fold those duplicates (replace in place, order preserved) so each turn renders exactly once
  // and MessageList never keys two children the same. Non-duplicated messages keep their object ref, so
  // `React.memo(AssistantMessage)` still bails on settled turns. See reconcileMessagesById.
  const view = useMemo(() => reconcileMessagesById(messages), [messages]);

  // `pending` = streaming OR the pre-stream run-wake gap. Drives BOTH the composer streaming state and
  // the MessageList answering indicator off one flag, so the indicator + Stop stay in lockstep.
  const pending = isStreaming(status) || awaiting;
  const composerState: ComposerState = pending ? "streaming" : "default";

  return (
    <div className="app" style={{ height: "100vh" }}>
      <Sidebar activeTitle={title} />
      <main className="main">
        <div className="canvas">
          <TitleBar title={title} />
          <div className="thread-scroll">
            <MessageList
              messages={view}
              pending={pending}
              usedFollowups={used}
              onFollowup={onFollowup}
              onRetry={onRetry}
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
