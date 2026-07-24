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

// The two fit-intent invite copies: one line + one primary button each.
const AUTH_INVITE_TEXT = "Sign in with Google to get matched — I’ll keep your profile and history.";
const PROFILE_INVITE_TEXT = "Add your resume and GitHub — I’ll find roles that fit you.";

// The card kinds that ARE the answer surface: when one is present the model's prose is suppressed (single-surface rule).
const ANSWER_CARD_KINDS = new Set([
  "insight",
  "error",
  "refusal",
  "profile-card",
  "postings",
  "auth-invite",
  "profile-invite",
]);

// Renders the live thread (presentation only; behavior delegated up via callbacks). `usedFollowups` is keyed `${cardId}::${chip}`.

// Memoized so a settled turn does NOT re-render while a later turn streams (useChat fires per data-* delta;
// Recharts is heavy). All props are ref-stable across a stream, so the shallow compare bails on settled turns.
const AssistantMessage = memo(function AssistantMessage({
  message,
  usedFollowups,
  onFollowup,
  onRetry,
  onOpenDetailPanel,
  onOpenPosting,
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
  onOpenDetailPanel: (messageId: string, partId: string) => void;
  onOpenPosting?: (source: string, externalId: string) => void;
  onSignIn?: () => void;
  onEditProfile?: () => void;
  onAuthInvite?: () => void;
  /** A turn is in flight - disables this card's chips. Flips only at turn boundaries, so settled cards still bail on the per-chunk re-map. */
  pending: boolean;
  /** The TAIL error card may offer Retry (regenerate re-answers the tail); false for every non-error turn, so the memo still bails. */
  retryable: boolean;
}) {
  const text = messageText(message);
  const cards = dataParts(message);
  // Single-surface rule: when this turn carries a rendered answer card, the model's prose is suppressed (never
  // card + a fabricated sentence). A loading skeleton does NOT suppress. Mirrors the persistence-layer drop.
  const hasCard = cards.some(({ data }) => ANSWER_CARD_KINDS.has(classifyCardData(data).kind));
  const showText = Boolean(text) && !hasCard;

  return (
    <>
      {showText ? (
        <Bubble role="ai">
          {/* Light markdown from the agent: render **bold**, strip the rest to plain. */}
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
                onOpenDetailPanel={onOpenDetailPanel}
                messageId={message.id}
                partId={id}
                pending={pending}
              />
            </div>
          );
        }
        if (cls.kind === "skeleton") {
          // Charts only when ready: a loading part shows the indicator, never a hollow card.
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
                onOpenPanel={() => onOpenDetailPanel(message.id, id)}
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
                onOpenPanel={() => onOpenDetailPanel(message.id, id)}
                onOpenPosting={onOpenPosting}
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

// User bubbles memoized on their message ref so a SETTLED user turn doesn't re-render (and its wrap-measure
// effect - a getComputedStyle + reflow - doesn't re-run) while a later turn streams.
const UserBubble = memo(function UserBubble({ message }: { message: UIMessage }) {
  return <Bubble role="user">{messageText(message)}</Bubble>;
});

/** Whether a message renders an error card; gates the tail-only Retry and suppresses a double live error card. */
function hasErrorCard(message: UIMessage): boolean {
  return dataParts(message).some(({ data }) => classifyCardData(data).kind === "error");
}

export function MessageList({
  messages,
  pending,
  usedFollowups,
  onFollowup,
  onRetry,
  onOpenDetailPanel,
  onOpenPosting,
  onSignIn,
  onEditProfile,
  onAuthInvite,
  liveError = false,
}: {
  messages: UIMessage[];
  pending: boolean;
  usedFollowups: Set<string>;
  onFollowup: (cardId: string, text: string) => void;
  onRetry: () => void;
  onOpenDetailPanel: (messageId: string, partId: string) => void;
  onOpenPosting?: (source: string, externalId: string) => void;
  onSignIn?: () => void;
  onEditProfile?: () => void;
  onAuthInvite?: () => void;
  /** useChat error state (a turn errored at the SDK level, streaming NO data-error part); render the card + Retry unless a part already covers the tail. */
  liveError?: boolean;
}) {
  const last = messages[messages.length - 1];
  // The answering indicator stands in while a turn is in flight and hasn't produced anything renderable (no
  // assistant message yet, or an empty one). Once a text/card part lands, it renders and the indicator drops.
  const lastEmptyAssistant = last?.role === "assistant" && !messageText(last) && dataParts(last).length === 0;
  const showTrailingIndicator = pending && (!last || last.role === "user" || lastEmptyAssistant);
  // Show the useChat-error card only when a data-error part didn't already stream for the tail (don't double-render); tail => always Retry.
  const showLiveError = liveError && !(last?.role === "assistant" && hasErrorCard(last));
  // A SETTLED (not pending) unanswered user tail is a failed/abandoned turn: the empty-turn persistence
  // contract stored no assistant row, so a reload hydrates the bare question. Surface the SAME error card +
  // Retry the live-error path shows - regenerate() over a user tail keeps it and fires "regenerate-message",
  // which the run gate answers. Excluded when liveError already owns the tail so the two never double-render.
  const showFailedTailRetry = !pending && !liveError && last?.role === "user";

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
            onOpenDetailPanel={onOpenDetailPanel}
            onOpenPosting={onOpenPosting}
            onSignIn={onSignIn}
            onEditProfile={onEditProfile}
            onAuthInvite={onAuthInvite}
            pending={pending}
            // Retry only on the TAIL error card (regenerate re-answers the tail); false otherwise, so the memo still bails.
            retryable={m.id === last?.id && hasErrorCard(m)}
          />
        ),
      )}
      {showLiveError || showFailedTailRetry ? (
        <div className="msg ai">
          <ErrorCard kind="system" onRetry={onRetry} />
        </div>
      ) : null}
      {showTrailingIndicator ? <AnsweringIndicator /> : null}
    </div>
  );
}
