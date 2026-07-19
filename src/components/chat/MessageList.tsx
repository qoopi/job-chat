"use client";

import type { UIMessage } from "ai";
import { Bubble } from "./Bubble";
import { InsightCard } from "@/components/insight/InsightCard";
import { InsightCardSkeleton } from "@/components/insight/InsightCardSkeleton";
import { ErrorCard, RefusalNotice } from "@/components/insight/ErrorCard";
import { classifyCardData, isStreaming, messageText } from "@/lib/chat-ui";

// Renders the live thread from `useChat` messages (AC-3/4/8/9/10/15 UI). Presentation only: given the
// message list + streaming status + the one-shot chip set, it maps each message's parts to the 005
// components (bubbles, insight cards, the streaming skeleton, error / refusal cards) - the same markup
// the 005 static Thread produced, so the existing card/tab/table e2e locators still match. Behavior
// (send, retry, chip) is delegated up via callbacks. `usedFollowups` is keyed `${cardId}::${chip}`.

function dataParts(message: UIMessage): { id: string; data: unknown }[] {
  return message.parts
    .filter((p) => typeof p.type === "string" && p.type.startsWith("data-"))
    .map((p, i) => ({ id: (p as { id?: string }).id ?? `${message.id}-p${i}`, data: (p as { data?: unknown }).data }));
}

function AssistantMessage({
  message,
  usedFollowups,
  onFollowup,
  onRetry,
}: {
  message: UIMessage;
  usedFollowups: Set<string>;
  onFollowup: (cardId: string, text: string) => void;
  onRetry: () => void;
}) {
  const text = messageText(message);
  const cards = dataParts(message);

  return (
    <>
      {text ? (
        <Bubble role="ai">{text}</Bubble>
      ) : null}
      {cards.map(({ id, data }) => {
        const cls = classifyCardData(data);
        if (cls.kind === "insight") {
          const used = cls.insight.followups.filter((f) => usedFollowups.has(`${cls.insight.id}::${f}`));
          return (
            <div key={id} className="msg ai">
              <InsightCard
                insight={cls.insight}
                usedFollowups={used}
                onFollowup={(text) => onFollowup(cls.insight.id, text)}
              />
            </div>
          );
        }
        if (cls.kind === "skeleton") {
          return (
            <div key={id} className="msg ai">
              <InsightCardSkeleton />
            </div>
          );
        }
        if (cls.kind === "error") {
          return (
            <div key={id} className="msg ai">
              <ErrorCard kind={cls.errorKind} onRetry={onRetry} />
            </div>
          );
        }
        if (cls.kind === "refusal") {
          return (
            <div key={id} className="msg ai">
              <RefusalNotice reason={cls.reason} />
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

export function MessageList({
  messages,
  status,
  usedFollowups,
  onFollowup,
  onRetry,
}: {
  messages: UIMessage[];
  status: string;
  usedFollowups: Set<string>;
  onFollowup: (cardId: string, text: string) => void;
  onRetry: () => void;
}) {
  const last = messages[messages.length - 1];
  // AC-8: a skeleton card stands in for the pending answer while the turn is in flight and has yet to
  // produce anything renderable - either the assistant message does not exist yet (last is the lone
  // user turn) or it exists but is still empty (between the stream's `start` and its first part). Once
  // a text or card part lands, that renders instead and the skeleton drops.
  const lastEmptyAssistant = last?.role === "assistant" && !messageText(last) && dataParts(last).length === 0;
  const showTrailingSkeleton = isStreaming(status) && (!last || last.role === "user" || lastEmptyAssistant);

  return (
    <div className="thread">
      {messages.map((m) =>
        m.role === "user" ? (
          <Bubble key={m.id} role="user">
            {messageText(m)}
          </Bubble>
        ) : (
          <AssistantMessage
            key={m.id}
            message={m}
            usedFollowups={usedFollowups}
            onFollowup={onFollowup}
            onRetry={onRetry}
          />
        ),
      )}
      {showTrailingSkeleton ? (
        <div className="msg ai">
          <InsightCardSkeleton />
        </div>
      ) : null}
    </div>
  );
}
