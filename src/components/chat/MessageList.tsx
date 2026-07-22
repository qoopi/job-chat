"use client";

import { Fragment, memo } from "react";
import type { UIMessage } from "ai";
import { Bubble } from "./Bubble";
import { AnsweringIndicator } from "./AnsweringIndicator";
import { InsightCard } from "@/components/insight/InsightCard";
import { ErrorCard, RefusalNotice } from "@/components/insight/ErrorCard";
import { InlinePromptCard } from "@/components/insight/InlinePromptCard";
import { ProfileCard } from "@/components/insight/ProfileCard";
import { PostingsCard } from "@/components/insight/PostingsCard";
import { classifyCardData, dataParts, messageText, proseSpans } from "@/lib/chat-ui";

// The two fit-intent invite copies (implement-cards.md #4): one line + one primary button each.
const AUTH_INVITE_TEXT = "Sign in with Google to get matched — I’ll keep your profile and history.";
const PROFILE_INVITE_TEXT = "Add your resume and GitHub — I’ll find roles that fit you.";

// The card kinds that ARE the answer surface: when one is present the model's accompanying prose is
// suppressed (single-surface rule), matching the persistence-layer drop so live + resumed render alike.
const ANSWER_CARD_KINDS = new Set([
  "insight",
  "error",
  "refusal",
  "profile-card",
  "postings",
  "auth-invite",
  "profile-invite",
]);

// Renders the live thread from `useChat` messages. Presentation only: given the message list +
// streaming status + the one-shot chip set, it maps each message's parts to bubbles, insight cards,
// the answering indicator, and error / refusal cards - the same markup the e2e locators match on.
// Behavior (send, retry, chip) is delegated up via callbacks. `usedFollowups` is keyed `${cardId}::${chip}`.

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
  onEditProfile,
  onAuthInvite,
  pending,
  retryable,
}: {
  message: UIMessage;
  usedFollowups: Set<string>;
  onFollowup: (cardId: string, text: string) => void;
  onRetry: () => void;
  onOpenLcp: (messageId: string, partId: string) => void;
  onSignIn?: () => void;
  /** Open the LCP profile form (profile card "Edit profile" / "Add GitHub"; profile-invite button). */
  onEditProfile?: () => void;
  /** The auth-invite button: open the auth dialog with a pending profile-invite. Absent when signed in. */
  onAuthInvite?: () => void;
  /** A turn is in flight - disables this card's follow-up chips (no concurrent send while it streams).
   *  `pending` only flips at turn boundaries (not per stream chunk), so settled cards still bail on the
   *  per-chunk re-map; the chart subtree stays memoized on the insight ref, so the flip is cheap. */
  pending: boolean;
  /** This turn's error card may offer Retry: it is the TAIL error card (regenerate re-answers the tail).
   *  Computed as `isTail && hasErrorCard`, so it stays `false` for every non-error turn - a settled
   *  insight card never re-renders just because a later turn appended after it (the memo still bails). */
  retryable: boolean;
}) {
  const text = messageText(message);
  const cards = dataParts(message);
  // Single-surface rule: when this turn carries any rendered answer card the CARD is the one answer
  // surface, so the model's accompanying prose is suppressed (a card + a fabricated sentence is never
  // shown together). A still-loading skeleton does NOT suppress (the card is not the answer yet).
  // Mirrors the persistence-layer drop in trigger/parts.ts, so live and resumed turns render identically.
  const hasCard = cards.some(({ data }) => ANSWER_CARD_KINDS.has(classifyCardData(data).kind));
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
          // Charts only when ready: a still-loading data-insight part shows the answering
          // indicator, never a hollow card. The full InsightCard mounts only once the part is complete.
          return <AnsweringIndicator key={id} />;
        }
        if (cls.kind === "error") {
          return (
            <div key={id} className="msg ai">
              <ErrorCard kind={cls.errorKind} onRetry={retryable ? onRetry : undefined} />
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
        if (cls.kind === "profile-card") {
          return (
            <div key={id} className="msg ai">
              <ProfileCard
                profile={cls.profile}
                onFollowup={(text) => onFollowup(id, text)}
                onEdit={onEditProfile}
                onOpenPanel={() => onOpenLcp(message.id, id)}
                pending={pending}
              />
            </div>
          );
        }
        if (cls.kind === "postings") {
          return (
            <div key={id} className="msg ai">
              <PostingsCard
                rows={cls.rows}
                total={cls.total}
                onFollowup={(text) => onFollowup(id, text)}
                onOpenPanel={() => onOpenLcp(message.id, id)}
                onEdit={onEditProfile}
                pending={pending}
              />
            </div>
          );
        }
        if (cls.kind === "auth-invite") {
          return (
            <div key={id} className="msg ai">
              <InlinePromptCard text={AUTH_INVITE_TEXT} buttonLabel="Sign in with Google" onAction={onAuthInvite} />
            </div>
          );
        }
        if (cls.kind === "profile-invite") {
          return (
            <div key={id} className="msg ai">
              <InlinePromptCard text={PROFILE_INVITE_TEXT} buttonLabel="Add your profile" onAction={onEditProfile} />
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

/** Whether a message renders an error card (a `data-error` part). Used to gate the tail-only Retry and
 *  to suppress the live error card when a streamed part already covers it. */
function hasErrorCard(message: UIMessage): boolean {
  return dataParts(message).some(({ data }) => classifyCardData(data).kind === "error");
}

export function MessageList({
  messages,
  pending,
  usedFollowups,
  onFollowup,
  onRetry,
  onOpenLcp,
  onSignIn,
  onEditProfile,
  onAuthInvite,
  liveError = false,
}: {
  messages: UIMessage[];
  /** A turn is in flight and has yet to produce content - streaming OR the pre-stream run-wake gap. */
  pending: boolean;
  usedFollowups: Set<string>;
  onFollowup: (cardId: string, text: string) => void;
  onRetry: () => void;
  /** Open a card's full body in the LCP (table / profile-card / postings), keyed by message + part id. */
  onOpenLcp: (messageId: string, partId: string) => void;
  /** Open the auth dialog from a guest cap notice. Absent (signed-in) hides the affordance. */
  onSignIn?: () => void;
  /** Open the LCP profile form (profile-card edit, profile-invite). */
  onEditProfile?: () => void;
  /** The auth-invite button handler (open the dialog with a pending profile-invite). */
  onAuthInvite?: () => void;
  /** Live: useChat is in its error state - a turn errored at the SDK level, which streams NO
   *  data-error part. Render the error card + Retry from this signal too, unless a data-error part
   *  already covers the tail (do not double-render). */
  liveError?: boolean;
}) {
  const last = messages[messages.length - 1];
  // The answering indicator stands in for the pending answer while the turn is in
  // flight and has yet to produce anything renderable - either the assistant message does not exist yet
  // (last is the lone user turn) or it exists but is still empty (between the stream's `start` and its
  // first part). `pending` also covers the pre-stream run-wake gap (arrival mint / follow-up action)
  // before the SDK moves status off "ready". Once a text or card part lands, that renders and the
  // indicator drops.
  const lastEmptyAssistant = last?.role === "assistant" && !messageText(last) && dataParts(last).length === 0;
  const showTrailingIndicator = pending && (!last || last.role === "user" || lastEmptyAssistant);
  // Show the error card from useChat's error state, but only when a data-error part did NOT
  // already stream for the tail (tool failures stream the part - do not double-render). This card is the
  // tail by construction, so it always offers Retry.
  const showLiveError = liveError && !(last?.role === "assistant" && hasErrorCard(last));

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
            onEditProfile={onEditProfile}
            onAuthInvite={onAuthInvite}
            pending={pending}
            // Retry only on the TAIL error card - regenerate re-answers the tail. `retryable` is false for
            // every non-error turn, so it never defeats the settled-card memo (it does not change when a
            // later turn appends after a settled insight card).
            retryable={m.id === last?.id && hasErrorCard(m)}
          />
        ),
      )}
      {showLiveError ? (
        <div className="msg ai">
          <ErrorCard kind="system" onRetry={onRetry} />
        </div>
      ) : null}
      {showTrailingIndicator ? <AnsweringIndicator /> : null}
    </div>
  );
}
