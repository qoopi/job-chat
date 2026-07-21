"use client";

import { Fragment, memo } from "react";
import type { UIMessage } from "ai";
import { Bubble } from "./Bubble";
import { AnsweringIndicator } from "./AnsweringIndicator";
import { InsightCard } from "@/components/insight/InsightCard";
import { ErrorCard, RefusalNotice } from "@/components/insight/ErrorCard";
import { classifyCardData, dataParts, messageText, proseSpans } from "@/lib/chat-ui";

// Renders the live thread from `useChat` messages (AC-3/4/8/9/10/15 UI). Presentation only: given the
// message list + streaming status + the one-shot chip set, it maps each message's parts to the 005
// components (bubbles, insight cards, the streaming skeleton, error / refusal cards) - the same markup
// the 005 static Thread produced, so the existing card/tab/table e2e locators still match. Behavior
// (send, retry, chip) is delegated up via callbacks. `usedFollowups` is keyed `${cardId}::${chip}`.

// Memoized so a settled turn does NOT re-render while a later turn streams: `useChat` fires a
// messages-changed callback per data-* delta, MessageList re-maps the whole thread, and each prior
// card (Recharts is heavy) would otherwise re-render on every chunk. The props are all ref-stable
// across a stream - `message` keeps its object ref once settled (the SDK preserves settled refs via
// slice), `usedFollowups` is unchanged mid-turn, and `onFollowup`/`onRetry` are useCallback-stable in
// ChatClient - so the default shallow compare bails on every settled turn. Proven by
// tests/component/message-list-memo.test.tsx (render-count probe).
const AssistantMessage = memo(function AssistantMessage({
  message,
  usedFollowups,
  onFollowup,
  onRetry,
  onOpenLcp,
  onSignIn,
  pending,
}: {
  message: UIMessage;
  usedFollowups: Set<string>;
  onFollowup: (cardId: string, text: string) => void;
  onRetry: () => void;
  onOpenLcp: (messageId: string, partId: string) => void;
  onSignIn?: () => void;
  /** A turn is in flight - disables this card's follow-up chips (no concurrent send while it streams).
   *  `pending` only flips at turn boundaries (not per stream chunk), so settled cards still bail on the
   *  per-chunk re-map; the chart subtree stays memoized on the insight ref, so the flip is cheap. */
  pending: boolean;
}) {
  const text = messageText(message);
  const cards = dataParts(message);
  // 018 strand 2 (extends AC-25's single-surface rule to SUCCESS cards): when this turn carries any
  // rendered card - a data insight, an error, or a refusal - the CARD is the one answer surface, so the
  // model's accompanying prose is suppressed (a card + a fabricated sentence is never shown together).
  // A still-loading skeleton does NOT suppress (the card is not the answer yet). Mirrors the
  // persistence-layer drop in trigger/parts.ts, so live and resumed turns render identically.
  const hasCard = cards.some(({ data }) => {
    const kind = classifyCardData(data).kind;
    return kind === "insight" || kind === "error" || kind === "refusal";
  });
  const showText = Boolean(text) && !hasCard;

  return (
    <>
      {showText ? (
        <Bubble role="ai">
          {/* Light markdown from the agent: render **bold** as bold, strip the rest to plain (#4a). */}
          {proseSpans(text).map((s, i) =>
            s.bold ? <strong key={i}>{s.text}</strong> : <Fragment key={i}>{s.text}</Fragment>,
          )}
        </Bubble>
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
                onOpenLcp={onOpenLcp}
                messageId={message.id}
                partId={id}
                pending={pending}
              />
            </div>
          );
        }
        if (cls.kind === "skeleton") {
          // Charts only when ready (006 ruling): a still-loading data-insight part shows the answering
          // indicator, never a hollow card. The full InsightCard mounts only once the part is complete.
          return <AnsweringIndicator key={id} />;
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
              <RefusalNotice reason={cls.reason} onSignIn={onSignIn} />
            </div>
          );
        }
        return null;
      })}
    </>
  );
});

// User bubbles are memoized on their message ref so a SETTLED user turn does not re-render - and its
// Bubble wrap-measure effect (a synchronous getComputedStyle + scrollHeight reflow) does not re-run -
// while a later turn streams. This is the same protection the AssistantMessage memo gives adviser
// turns; without it, MessageList's per-chunk re-map would re-measure every prior user bubble, cost
// scaling with thread length. `message` is ref-stable once settled, so the shallow compare bails.
const UserBubble = memo(function UserBubble({ message }: { message: UIMessage }) {
  return <Bubble role="user">{messageText(message)}</Bubble>;
});

export function MessageList({
  messages,
  pending,
  usedFollowups,
  onFollowup,
  onRetry,
  onOpenLcp,
  onSignIn,
}: {
  messages: UIMessage[];
  /** A turn is in flight and has yet to produce content - streaming OR the pre-stream run-wake gap. */
  pending: boolean;
  usedFollowups: Set<string>;
  onFollowup: (cardId: string, text: string) => void;
  onRetry: () => void;
  /** AC-8: open a table card's full body in the LCP, keyed by its message + part id. */
  onOpenLcp: (messageId: string, partId: string) => void;
  /** AC-13: open the auth dialog from a guest cap notice. Absent (signed-in) hides the affordance. */
  onSignIn?: () => void;
}) {
  const last = messages[messages.length - 1];
  // AC-8 (006 ruling): the answering indicator stands in for the pending answer while the turn is in
  // flight and has yet to produce anything renderable - either the assistant message does not exist yet
  // (last is the lone user turn) or it exists but is still empty (between the stream's `start` and its
  // first part). `pending` also covers the pre-stream run-wake gap (arrival mint / follow-up action)
  // before the SDK moves status off "ready". Once a text or card part lands, that renders and the
  // indicator drops.
  const lastEmptyAssistant = last?.role === "assistant" && !messageText(last) && dataParts(last).length === 0;
  const showTrailingIndicator = pending && (!last || last.role === "user" || lastEmptyAssistant);

  return (
    <div className="thread">
      {messages.map((m) =>
        m.role === "user" ? (
          <UserBubble key={m.id} message={m} />
        ) : (
          <AssistantMessage
            key={m.id}
            message={m}
            usedFollowups={usedFollowups}
            onFollowup={onFollowup}
            onRetry={onRetry}
            onOpenLcp={onOpenLcp}
            onSignIn={onSignIn}
            pending={pending}
          />
        ),
      )}
      {showTrailingIndicator ? <AnsweringIndicator /> : null}
    </div>
  );
}
