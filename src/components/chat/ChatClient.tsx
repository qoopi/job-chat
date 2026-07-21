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
import { LcpProfile } from "./LcpProfile";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { authClient } from "@/lib/auth-client";
import { useJobChatTransport } from "@/lib/chat-transport";
import { persistedSessionIsStreaming } from "@/lib/chat-session-store";
import {
  classifyCardData,
  dataParts,
  isStreaming,
  reconcileMessagesById,
  resolveInsightTarget,
  type LcpTarget,
} from "@/lib/chat-ui";
import { isAuthDialogOpen, isMenuOpen } from "@/lib/layers";
import { queueDraft, takeQueuedDraft } from "@/lib/queued-draft";
import {
  closeAuthDialog,
  openAuthDialog,
  useAuthDialogOpen,
  useOpenAuthDialogOnError,
} from "@/lib/auth-dialog";
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
  newChat = false,
  e2e = false,
  signedIn: signedInInitial = false,
  // `accountName` needs no client flip - Google-only sign-in is a full-page redirect, so the server
  // re-render already carries the real name (only `signedIn` becomes client state, below).
  accountName,
  accountEmail,
  conversations: conversationsInitial = [],
  profileOnArrival = false,
  fromAuth = false,
}: {
  conversationId: string;
  title?: string;
  initialMessages: UIMessage[];
  pendingQuestion?: string;
  autoStream?: boolean;
  /** 017: a fresh chat shell (`/chat/new`) - no thread to resume; the first send starts a new conversation
   *  (arms `freshChatRef`). The landing-initiated sign-in's destination. */
  newChat?: boolean;
  e2e?: boolean;
  /** AC-12/AC-13: SSR-resolved sign-in state + the account's history (empty for a guest). Client state
   *  takes over after an in-page sign-in / sign-out (no full-page refresh needed). */
  signedIn?: boolean;
  accountName?: string;
  /** refresh #2 s4: the account menu header shows the email (accountName is the display name). */
  accountEmail?: string;
  conversations?: (Pick<Conversation, "id" | "title" | "created_at"> & {
    preview?: string;
  })[];
  /** refresh #2 s10: arriving from the landing's account menu "Your profile" (`/chat/new?profile=1`)
   *  opens the profile LCP on mount (the landing has no LCP of its own). */
  profileOnArrival?: boolean;
  /** Fix round (item 2): this mount is a genuine post-auth return - `/auth/complete` set `?fromAuth=1`
   *  on the destination after finalizing the sign-in. ONLY such an arrival may replay a queued draft; a
   *  later ordinary signed-in mount that happens to find a stale key (the shared "/chat/new" key) must
   *  not auto-send it. */
  fromAuth?: boolean;
}) {
  const router = useRouter();
  const transport = useJobChatTransport({ e2e, conversationId });
  // Resume a mid-stream reload: when the persisted session says a turn is still streaming, `useChat`
  // drives `reconnectToStream` on mount to finish it from the persisted cursor (a settled session leaves
  // this false, so a reload of a completed turn never replays). Read once at mount (SSR-guarded).
  const [resume] = useState(() => persistedSessionIsStreaming(conversationId));
  const {
    messages,
    sendMessage,
    stop,
    status,
    error,
    regenerate,
    setMessages,
    resumeStream,
  } = useChat({
    id: conversationId,
    transport,
    messages: initialMessages,
    resume,
  });

  const [draft, setDraft] = useState("");
  // The title bar + guest active-row title follow client state so New chat / deleting the open
  // conversation return them to the "New chat" empty state in place (AC-19/AC-21), seeded from the SSR title.
  const [titleState, setTitleState] = useState(title);
  // AC-19 New chat in place: after a client-side reset, the NEXT message starts a brand-new conversation
  // (the landing handoff), not a follow-up on the reset thread. This ref arms that first send. A ref (not
  // state) because it only steers the imperative send path - it never needs to re-render. Seeded from
  // `newChat` so a `/chat/new` shell (017) is armed from mount - its first send creates the conversation.
  const freshChatRef = useRef(newChat);
  // AC-19: bumped on New chat to move focus to the composer (Composer watches this).
  const [focusNonce, setFocusNonce] = useState(0);
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  // Auth is client-driven after mount: `signedIn`/`conversations` seed from the SSR resolve, then an
  // in-page sign-in / sign-out flips them (the sidebar updates without a full-page refresh). `dialogOpen`
  // comes from the shared open-store (interaction-spec s6; one dialog at a time).
  const [signedIn, setSignedIn] = useState(signedInInitial);
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
  // refresh #2 s7: the account menu's "Your profile" opens the profile in the LCP. One LCP at a time -
  // opening a table closes the profile and vice versa.
  const [profileOpen, setProfileOpen] = useState(profileOnArrival);
  const openLcp = useCallback((messageId: string, partId: string) => {
    setProfileOpen(false);
    setLcpTarget({ messageId, partId });
  }, []);
  const closeLcp = useCallback(() => setLcpTarget(null), []);
  const openProfile = useCallback(() => {
    setLcpTarget(null);
    setProfileOpen(true);
  }, []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);

  // AC-19: New chat starts fresh IN PLACE (interaction-spec s5) - clear the thread, close the LCP, clear
  // and focus the composer, WITHOUT navigating to the landing. The signed-in user's current conversation
  // simply stays in history (already persisted; nothing to save). `freshChatRef` arms the next send to
  // create a brand-new conversation instead of following up on the (now-cleared) one.
  const startNewChat = useCallback(() => {
    freshChatRef.current = true;
    setMessages([]);
    setLcpTarget(null);
    setProfileOpen(false);
    setDraft("");
    setFailed(null);
    setTitleState(undefined); // title bar returns to the "New chat" empty state
    setFocusNonce((n) => n + 1);
  }, [setMessages]);

  // The polite cap/budget notice, rendered as a data-refusal turn so the one MessageList path shows it
  // (decision 19 / 004 handoff), not a bespoke banner. A GUEST cap renders the warm accent-soft register
  // card (RefusalNotice, refresh #2 s8) and flips the derived `capped` state below - it does NOT auto-open
  // the dialog anymore; the card + a queued send invite it. The blocked draft stays in the composer for
  // that queued send. Shared by the follow-up and the fresh-chat send paths (DRY).
  const showRefusal = useCallback(
    (reason: "guest_cap" | "daily_budget", text: string) => {
      const id = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        {
          id,
          role: "assistant",
          parts: [{ type: "data-refusal", id: `${id}-refusal`, data: { reason } }],
        } as UIMessage,
      ]);
      setDraft(text); // the blocked draft stays in the composer (the queued message; survives cancel)
    },
    [setMessages],
  );

  // A send that could not go through (invalid input / not_found / a thrown round trip): show the retry
  // toast and restore the text as the draft so it is never lost. Shared by the fresh-chat and follow-up
  // send paths (DRY). A cap/budget refusal takes `showRefusal` instead (it also arms the auth flow).
  const failSend = useCallback((text: string) => {
    setFailed(text);
    setDraft(text);
  }, []);

  // refresh #2 s8: a guest is "capped" once a guest_cap refusal is in the thread (from either the action
  // gate or the agent backstop). Derived from the messages so it needs no separate state - New chat
  // clears the thread (uncaps) and a sign-in flips `signedIn` (uncaps). Drives the composer's capped
  // placeholder and the send -> dialog gate below.
  const capped = useMemo(
    () =>
      !signedIn &&
      messages.some(
        (m) =>
          m.role === "assistant" &&
          dataParts(m).some((p) => {
            const cls = classifyCardData(p.data);
            return cls.kind === "refusal" && cls.reason === "guest_cap";
          }),
      ),
    [signedIn, messages],
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      // refresh #2 s8 (AC-D31/D32): while capped, a send does not go to the server - it queues the draft
      // (in the composer AND in sessionStorage, which survives the Google full-page sign-in redirect) and
      // opens the register dialog. On return - now signed in - the mount effect auto-sends it (ruling 1).
      if (capped) {
        setDraft(text);
        queueDraft(conversationId, text);
        openAuthDialog();
        return;
      }
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
            router.push(
              `/chat/${crypto.randomUUID()}?new=1&q=${encodeURIComponent(text)}`,
            );
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
        {
          id: userMessageId,
          role: "user",
          parts: [{ type: "text", text }],
        } as UIMessage,
      ]);
      const rollbackEcho = () =>
        setMessages((prev) => prev.filter((m) => m.id !== userMessageId));

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
          // DELIVER + WATCH the turn via the transport's `sendMessages` (`useChat.sendMessage`). That one
          // primitive appends the turn to `.in` (which triggers the run) AND subscribes with wait - the
          // only SDK 4.5.4 path that streams a freshly-triggered follow-up live. `resumeStream` forces
          // peekSettled (reload-resume): attaching to a run triggered milliseconds earlier it reads the
          // settled prior turn and never delivers the fresh chunks (006 diagnosis, routed to 004). The
          // send path threads no session state: the transport owns the `.out` cursor and refreshes its
          // token via the `accessToken` callback on 401 (F1/F7). Passing `messageId` makes the SDK
          // reconcile with the optimistic bubble above (replace in place), so the user turn renders once.
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
    [
      e2e,
      conversationId,
      router,
      sendMessage,
      setMessages,
      showRefusal,
      failSend,
      capped,
    ],
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
      transport.setSession(conversationId, {
        publicAccessToken: r.token,
        isStreaming: true,
      });
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
      else if (!e2e && autoStream) {
        void attachOnArrival();
        // Strip ?new=1 so a later reload cannot re-run the arrival attach - its cursor-less resume replays
        // settled turns as duplicate bubbles (F4). router.replace soft-navigates: the same ChatClient
        // instance keeps its state and the in-flight stream, only the searchParam clears, so a reload
        // mounts with autoStream=false and resumes via the persisted session instead (R1). 024 deletes it.
        router.replace(`/chat/${conversationId}`);
      }
      // refresh #2 s8 (AC-D32): a capped guest's draft queued before the Google sign-in redirect carries
      // across via sessionStorage; on the genuine post-auth return (fromAuth) - now signed in - auto-send
      // it exactly once. Fix round (item 2): the "/chat/new" key is SHARED, so a later ORDINARY signed-in
      // mount (landing "Your profile" / "Open your chats") could otherwise pick up a stale abandoned-
      // sign-in draft and fire an unintended send. We take-and-clear on any signed-in mount (a signed-in
      // user never legitimately owns a queued draft - `capped` requires !signedIn - so a found key is
      // stale) but only SEND when this is a post-auth arrival.
      else if (signedIn) {
        const queued = takeQueuedDraft(conversationId);
        if (queued && fromAuth) void send(queued);
      }
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

  // Stop pairs the transport's backend signal with the AI SDK stop (conformance correction 6). After a
  // resumed mount `useChat.stop()` aborts only the local reader - the AI SDK does not thread an abort
  // through `reconnectToStream` - so without `stopGeneration` the backend keeps generating. E2E has no
  // backend (the mock's stopGeneration is inert) and the AI SDK stop still aborts the scripted stream.
  const onStop = useCallback(() => {
    void transport.stopGeneration(conversationId);
    void stop();
  }, [transport, conversationId, stop]);

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
  const targetMessage = lcpTarget
    ? (view.find((m) => m.id === lcpTarget.messageId) ?? null)
    : null;
  const lcpInsight = useMemo(
    () =>
      targetMessage && lcpTarget
        ? resolveInsightTarget([targetMessage], lcpTarget)
        : null,
    [targetMessage, lcpTarget],
  );

  // AC-9 close-on-Esc, honoring the layer priority (interaction-spec + refresh #2 ruling 4): dialog >
  // menu > LCP. The auth dialog and the account menu both sit ABOVE the LCP and take Esc first, so this
  // handler yields while either `isAuthDialogOpen()` or `isMenuOpen()` is true (the menu closes on the
  // same keydown, leaving the LCP for a second Esc). The dialog's own Esc handler also calls
  // `stopImmediatePropagation`, so if it runs first this handler never fires - order-independent either
  // way. Otherwise Esc closes the LCP. Bound once; the functional setState reads current.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (isAuthDialogOpen() || isMenuOpen()) return; // a layer above the LCP consumes Esc first
      // Close whichever LCP view is open (table or profile). They are mutually exclusive, so at most one
      // of these does anything; the other is already closed.
      setProfileOpen(false);
      setLcpTarget((t) => (t ? null : t));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // `pending` = streaming OR the pre-stream run-wake gap. Drives BOTH the composer streaming state and
  // the MessageList answering indicator off one flag, so the indicator + Stop stay in lockstep. The auth
  // dialog dims the composer (interaction-spec section 4). When capped (refresh #2 s8) the composer stays
  // ENABLED with its register placeholder - a send there opens the dialog with the draft queued.
  const pending = isStreaming(status) || awaiting;
  // AC-7 (live): a turn that errors at the SDK level surfaces on useChat's `error` state but streams NO
  // data-error part, so MessageList would otherwise show no live error card for that class (tool failures
  // stream the part and are unaffected). Feed the error state through so the card + Retry show live too;
  // regenerate clears `error` on the next attempt, so the card drops once Retry runs.
  const liveError = error != null;
  const composerState: ComposerState = dialogOpen
    ? "disabled"
    : pending
      ? "streaming"
      : capped
        ? "capped"
        : "default";

  return (
    <div className="app" style={{ height: "100vh" }}>
      <Sidebar
        signedIn={signedIn}
        conversations={conversations}
        activeId={conversationId}
        activeTitle={titleState}
        onNewChat={startNewChat}
        onSignIn={openAuthDialog}
        onDeleteConversation={(id) => void onDeleteConversation(id)}
      />
      <main className="main">
        {/* AC-8 / s7: the LCP takes the middle of the canvas (a table OR the profile) while the chat
            docks to the 360px right rail. */}
        {profileOpen ? (
          <LcpProfile onClose={closeProfile} />
        ) : lcpInsight ? (
          <LcpPanel insight={lcpInsight} onClose={closeLcp} />
        ) : null}
        <div className={profileOpen || lcpInsight ? "canvas docked" : "canvas"}>
          <TitleBar
            title={titleState}
            signedIn={signedIn}
            accountName={accountName}
            email={accountEmail}
            onSignIn={openAuthDialog}
            onOpenProfile={openProfile}
            onSignOut={() => void onSignOut()}
          />
          <div className="thread-scroll">
            <MessageList
              messages={view}
              pending={pending}
              usedFollowups={used}
              onFollowup={onFollowup}
              onRetry={onRetry}
              onOpenLcp={openLcp}
              onSignIn={signedIn ? undefined : openAuthDialog}
              liveError={liveError}
            />
          </div>
          <Composer
            state={composerState}
            value={draft}
            onChange={setDraft}
            onSend={onComposerSend}
            onStop={onStop}
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
      {/* Topmost layer (interaction-spec "Priority of layers": auth dialog > LCP > thread). Sign-in from
          inside a chat returns to THIS conversation (017 fix round 2). */}
      {dialogOpen ? (
        <AuthDialog
          onClose={closeAuthDialog}
          next={`/chat/${conversationId}`}
        />
      ) : null}
    </div>
  );
}
