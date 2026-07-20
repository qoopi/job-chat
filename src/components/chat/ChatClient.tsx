"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import type { Conversation } from "@shared/store";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { Composer, type ComposerState } from "./Composer";
import { MessageList } from "./MessageList";
import { LcpPanel } from "./LcpPanel";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { authClient } from "@/lib/auth-client";
import { useJobChatTransport } from "@/lib/chat-transport";
import { isStreaming, reconcileMessagesById, resolveInsightTarget, type LcpTarget } from "@/lib/chat-ui";
import { isAuthDialogOpen } from "@/lib/layers";
import { closeAuthDialog, openAuthDialog, useAuthDialogOpen, useOpenAuthDialogOnError } from "@/lib/auth-dialog";
import {
  clearGuestSession,
  deleteConversation as deleteConversationAction,
  mintChatToken,
  sendMessage as sendMessageAction,
  startConversation as startConversationAction,
} from "@/app/actions";

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

export function ChatClient({
  conversationId,
  title,
  initialMessages,
  pendingQuestion,
  autoStream = false,
  e2e = false,
  signedIn: signedInInitial = false,
  accountName: accountNameInitial,
  conversations: conversationsInitial = [],
}: {
  conversationId: string;
  title?: string;
  initialMessages: UIMessage[];
  pendingQuestion?: string;
  autoStream?: boolean;
  e2e?: boolean;
  /** AC-12/AC-13: SSR-resolved sign-in state + the account's history (empty for a guest). Client state
   *  takes over after an in-page sign-in / sign-out (no full-page refresh needed). */
  signedIn?: boolean;
  accountName?: string;
  conversations?: Pick<Conversation, "id" | "title" | "created_at">[];
}) {
  const router = useRouter();
  const transport = useJobChatTransport({ e2e });
  const { messages, sendMessage, stop, status, regenerate, setMessages, resumeStream } = useChat({
    id: conversationId,
    transport,
    messages: initialMessages,
  });

  const [draft, setDraft] = useState("");
  // The title bar + guest active-row title follow client state so New chat / deleting the open
  // conversation return them to the "New chat" empty state in place (AC-19/AC-21), seeded from the SSR title.
  const [titleState, setTitleState] = useState(title);
  // AC-19 New chat in place: after a client-side reset, the NEXT message starts a brand-new conversation
  // (the landing handoff), not a follow-up on the reset thread. This ref arms that first send. A ref (not
  // state) because it only steers the imperative send path - it never needs to re-render.
  const freshChatRef = useRef(false);
  // AC-19: bumped on New chat to move focus to the composer (Composer watches this).
  const [focusNonce, setFocusNonce] = useState(0);
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  // Auth is client-driven after mount: `signedIn`/`conversations` seed from the SSR resolve, then an
  // in-page sign-in / sign-out flips them (the sidebar updates without a full-page refresh). `dialogOpen`
  // comes from the shared open-store (interaction-spec s6; one dialog at a time).
  const [signedIn, setSignedIn] = useState(signedInInitial);
  // `accountName` comes from the SSR resolve (guest -> undefined). Under Google-only sign-in the account
  // arrives via a full-page redirect, so the server re-render carries the real name - no client flip.
  const accountName = accountNameInitial;
  const [conversations, setConversations] = useState(conversationsInitial);
  // Reentrancy guard: while a turn is in flight (`send` between its start and its finally), a second
  // `send` is ignored. Without it a follow-up chip clicked mid-stream fires a concurrent
  // `sendMessage({ messageId })`, which truncates-after-id and can drop the in-flight send's optimistic
  // bubble (spurious "Could not send" + an orphan persisted turn + a duplicate run - the AC-16 class). A
  // ref (not `pending` state) so the check reads current synchronously without adding `pending` to
  // `send`'s deps (which would rebuild the callback and defeat the MessageList memo bail). Ignoring the
  // duplicate mid-stream send mirrors the composer's own streaming-disabled state.
  const sendingRef = useRef(false);
  const dialogOpen = useAuthDialogOpen();
  useOpenAuthDialogOnError(); // a Google redirect error (?error=) opens the dialog so it can be surfaced
  // Instant "answering" feedback (006 ruling): set the moment a turn is sent or the arrival attach
  // begins, so the indicator + streaming composer appear AT ONCE and bridge the run-wake gap before the
  // SDK moves `status` off "ready". `pending` is `isStreaming(status) || awaiting`, so once the stream is
  // live `status` dominates; the send/attach `finally` clears the flag when the await chain settles
  // (stream end, Stop-abort, refusal, invalid, or a no-op reconnect), never leaving it stuck.
  const [awaiting, setAwaiting] = useState(false);
  const started = useRef(false);

  // AC-8/AC-9: the open Left Chat Part, held by identity (`{ messageId, partId }`) so its body
  // re-resolves from the immutable message payload - a resumed conversation renders the same LCP. One
  // at a time: opening from another card just replaces the target.
  const [lcpTarget, setLcpTarget] = useState<LcpTarget | null>(null);
  const openLcp = useCallback((messageId: string, partId: string) => setLcpTarget({ messageId, partId }), []);
  const closeLcp = useCallback(() => setLcpTarget(null), []);

  // AC-19: New chat starts fresh IN PLACE (interaction-spec s5) - clear the thread, close the LCP, clear
  // and focus the composer, WITHOUT navigating to the landing. The signed-in user's current conversation
  // simply stays in history (already persisted; nothing to save). `freshChatRef` arms the next send to
  // create a brand-new conversation instead of following up on the (now-cleared) one.
  const startNewChat = useCallback(() => {
    freshChatRef.current = true;
    setMessages([]);
    setLcpTarget(null);
    setDraft("");
    setFailed(null);
    setTitleState(undefined); // title bar returns to the "New chat" empty state
    setFocusNonce((n) => n + 1);
  }, [setMessages]);

  // The polite cap/budget notice, rendered as a data-refusal turn so the one MessageList path shows it
  // (decision 19 / 004 handoff), not a bespoke banner. A GUEST hitting the cap also queues the blocked
  // draft and opens the lazy dialog for auto-send on sign-in (AC-10/AC-11); a signed-in cap or a
  // post-sign-in re-send just shows the notice and keeps the draft. Shared by the follow-up and the
  // fresh-chat send paths (DRY).
  const showRefusal = useCallback(
    (reason: "guest_cap" | "daily_budget", text: string) => {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "data-refusal", data: { reason } }] } as UIMessage,
      ]);
      setDraft(text); // the blocked draft stays in the composer (survives the dialog / cancel)
      // A guest hitting the cap gets the sign-in dialog. Google is a full-page redirect, so there is no
      // in-page auto-send of the blocked draft (that path was email-only, now removed) - the notice and
      // the draft remain for the user to retry after signing in.
      if (reason === "guest_cap" && !signedIn) openAuthDialog();
    },
    [signedIn, setMessages],
  );

  // A send that could not go through (invalid input / not_found / a thrown round trip): show the retry
  // toast and restore the text as the draft so it is never lost. Shared by the fresh-chat and follow-up
  // send paths (DRY). A cap/budget refusal takes `showRefusal` instead (it also arms the auth flow).
  const failSend = useCallback((text: string) => {
    setFailed(text);
    setDraft(text);
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      if (sendingRef.current) return; // a turn is already in flight - ignore the concurrent send
      sendingRef.current = true;
      setFailed(null);
      setAwaiting(true); // instant answering indicator + streaming composer through the run-wake gap

      // AC-19: the first message after New chat starts a NEW conversation (the landing handoff), then
      // soft-navigates to it (no full reload) - the new page attaches the stream on arrival. Mirrors
      // LandingComposer's submit exactly. Awaiting stays set through the navigation (the component
      // unmounts on push); a refusal clears it and shows the notice.
      if (freshChatRef.current) {
        try {
          if (e2e) {
            router.push(`/chat/${crypto.randomUUID()}?new=1&q=${encodeURIComponent(text)}`);
            return;
          }
          const r = await startConversationAction(text);
          if (r.ok) {
            freshChatRef.current = false;
            router.push(`/chat/${r.conversationId}?new=1`);
            return;
          }
          if (r.reason === "guest_cap" || r.reason === "daily_budget") {
            showRefusal(r.reason, text);
          } else {
            failSend(text); // invalid_input -> send-failure toast, draft preserved
          }
        } catch {
          failSend(text);
        } finally {
          sendingRef.current = false; // release the guard (moot when we navigated away - the page remounts)
          if (freshChatRef.current) setAwaiting(false); // only when we did NOT navigate away
        }
        return;
      }

      // AC-22 optimistic echo: the user's bubble enters the rendered view NOW, at composer-clear time,
      // before the gate/transport round trip - the send never waits on the ~6s run-wake gap. On the happy
      // path the SDK's `sendMessage({ messageId })` REPLACES this exact id in place (and `reconcileMessagesById`
      // is the backstop, so no duplicate); a gate refusal or a send failure rolls it back (flow C: a
      // blocked/failed message is not shown as sent).
      const userMessageId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: userMessageId, role: "user", parts: [{ type: "text", text }] } as UIMessage,
      ]);
      const rollbackEcho = () => setMessages((prev) => prev.filter((m) => m.id !== userMessageId));

      try {
        if (e2e) {
          // Mock transport streams the scripted turn; a Stop-abort rejects here and is expected (no toast).
          try {
            await sendMessage({ text, messageId: userMessageId });
          } catch {
            /* stream aborted (Stop) or mock stream error - e2e only, no send-failure toast */
          }
          return;
        }

        try {
          const r = await sendMessageAction(conversationId, text);
          if (!r.ok) {
            rollbackEcho(); // AC-22: a refused send is not shown as sent (flow C)
            if (r.reason === "guest_cap" || r.reason === "daily_budget") {
              showRefusal(r.reason, text);
              return;
            }
            failSend(text); // invalid_input / not_found -> toast + preserved draft (interaction-spec section 4)
            return;
          }
          // Hydrate the transport with the action's scoped token, then DELIVER + WATCH the turn via the
          // transport's `sendMessages` (`useChat.sendMessage`). That one primitive appends the turn to
          // `.in` (which triggers the run) AND subscribes with wait - the only SDK 4.5.4 path that streams
          // a freshly-triggered follow-up live. `resumeStream`/`reconnectToStream` forces peekSettled,
          // built for reload-resume: attaching to a run triggered milliseconds earlier it reads the
          // settled prior turn and never delivers the fresh chunks (006 diagnosis, routed to 004).
          // Passing `messageId` makes the SDK reconcile with the optimistic bubble above (replace in place),
          // so the user turn renders exactly once.
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
          await sendMessage({ text, messageId: userMessageId });
        } catch {
          rollbackEcho(); // AC-22: a failed send returns to the composer (toast + draft), not a stuck bubble
          failSend(text);
        }
      } finally {
        sendingRef.current = false; // release the guard once this turn's await chain settles
        setAwaiting(false); // fallback clear for paths that never stream (refusal / invalid / abort)
      }
    },
    [e2e, conversationId, router, sendMessage, setMessages, transport, showRefusal, failSend],
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

  // Sign out (017): drop the Better Auth session, then land the user on the LANDING as a guest with no
  // stale thread. On success (Better Auth's onSuccess), return the sidebar to its guest state, clear the
  // open thread + history, rotate the guest cookie (defensive - the Google path already cleared it), and
  // redirect to "/". A failed sign-out leaves the session in place (no data loss) and stays put.
  const onSignOut = useCallback(async () => {
    await authClient
      .signOut({
        fetchOptions: {
          onSuccess: () => {
            setSignedIn(false);
            setConversations([]);
            startNewChat(); // clear the open thread so no stale conversation lingers post-sign-out
            void clearGuestSession(); // rotate the guest cookie so the next visit starts a fresh guest
            router.push("/"); // land the signed-out user on the landing
          },
        },
      })
      .catch(() => {
        /* a failed sign-out leaves the session in place - no data loss */
      });
  }, [router, startNewChat]);

  // AC-21: delete a conversation from the sidebar (signed-in only; the action re-checks ownership). Drop
  // it from the history list, and if it is the OPEN one, clear to the fresh-chat state (reuse AC-19's
  // path). A refusal (someone else's id / transient error) leaves the list untouched.
  const onDeleteConversation = useCallback(
    async (id: string) => {
      const r = await deleteConversationAction(id);
      if (!r.ok) return;
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === conversationId) startNewChat();
    },
    [conversationId, startNewChat],
  );

  // Reconcile by id at the merge seam: a hydrated conversation that reconnects to a live run re-receives
  // its already-present assistant tail from the SDK's session replay, which the AI SDK appends under the
  // same id. Fold those duplicates (replace in place, order preserved) so each turn renders exactly once
  // and MessageList never keys two children the same. Non-duplicated messages keep their object ref, so
  // `React.memo(AssistantMessage)` still bails on settled turns. See reconcileMessagesById.
  const view = useMemo(() => reconcileMessagesById(messages), [messages]);

  // The open LCP's body, re-resolved from the current (immutable) messages. Cheap ref-find of the target
  // message each render; the EXPENSIVE resolve (classify + Zod safeParse -> a FRESH insight object, whose
  // new `rows` ref makes the un-memoized DataTable re-sort up to 50 rows) is memoized on that message's
  // REF, not the whole `view` array. `view` is a fresh ref every stream chunk (reconcileMessagesById
  // rebuilds the array), but a settled target keeps its object ref - so an LCP left open during an
  // unrelated follow-up's stream does NOT re-parse or re-sort per chunk. Truthiness also gates the dock:
  // an unresolvable target (can't happen in practice - payloads persist) docks/renders nothing.
  const targetMessage = lcpTarget ? view.find((m) => m.id === lcpTarget.messageId) ?? null : null;
  const lcpInsight = useMemo(
    () => (targetMessage && lcpTarget ? resolveInsightTarget([targetMessage], lcpTarget) : null),
    [targetMessage, lcpTarget],
  );

  // AC-9 close-on-Esc, honoring the layer priority (interaction-spec): the open auth dialog sits above
  // the LCP and takes Esc first. This handler yields while `isAuthDialogOpen()` is true; independently,
  // the dialog's own Esc handler calls `stopImmediatePropagation`, so if it happens to run first this
  // handler never fires at all - order-independent either way. Otherwise Esc closes the LCP. Bound once;
  // the functional setState reads current.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (isAuthDialogOpen()) return; // a layer above the LCP consumes Esc first
      setLcpTarget((t) => (t ? null : t));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // `pending` = streaming OR the pre-stream run-wake gap. Drives BOTH the composer streaming state and
  // the MessageList answering indicator off one flag, so the indicator + Stop stay in lockstep. The auth
  // dialog dims the composer (interaction-spec section 4 - and this is the brief input disable against
  // an Enter-repeat at the cap moment: the dialog auto-opens, so the composer is inert while it is up).
  const pending = isStreaming(status) || awaiting;
  const composerState: ComposerState = dialogOpen ? "disabled" : pending ? "streaming" : "default";

  return (
    <div className="app" style={{ height: "100vh" }}>
      <Sidebar
        signedIn={signedIn}
        accountName={accountName}
        conversations={conversations}
        activeId={conversationId}
        activeTitle={titleState}
        onNewChat={startNewChat}
        onSignIn={openAuthDialog}
        onSignOut={() => void onSignOut()}
        onDeleteConversation={(id) => void onDeleteConversation(id)}
      />
      <main className="main">
        {/* AC-8: the LCP takes the middle of the canvas while the chat docks to the 360px right rail. */}
        {lcpInsight ? <LcpPanel insight={lcpInsight} onClose={closeLcp} /> : null}
        <div className={lcpInsight ? "canvas docked" : "canvas"}>
          <TitleBar title={titleState} />
          <div className="thread-scroll">
            <MessageList
              messages={view}
              pending={pending}
              usedFollowups={used}
              onFollowup={onFollowup}
              onRetry={onRetry}
              onOpenLcp={openLcp}
              onSignIn={signedIn ? undefined : openAuthDialog}
            />
          </div>
          <Composer
            state={composerState}
            value={draft}
            onChange={setDraft}
            onSend={onComposerSend}
            onStop={() => void stop()}
            focusSignal={focusNonce}
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
      {/* Topmost layer (interaction-spec "Priority of layers": auth dialog > LCP > thread). */}
      {dialogOpen ? <AuthDialog onClose={closeAuthDialog} /> : null}
    </div>
  );
}
