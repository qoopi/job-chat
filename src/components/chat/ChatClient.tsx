"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import type { Conversation } from "@shared/store";
import type { Profile } from "@shared/profile";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { Composer, type ComposerState } from "./Composer";
import { MessageList } from "./MessageList";
import { DetailPanel } from "./DetailPanel";
import { ProfilePanel } from "./ProfilePanel";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { authClient } from "@/lib/auth-client";
import { useJobChatTransport } from "@/lib/chat-transport";
import { persistedSessionIsStreaming } from "@/lib/chat-session-store";
import {
  classifyCardData,
  dataParts,
  dedupeInviteCards,
  isStreaming,
  messageText,
  reconcileMessagesById,
  resolveDetailContent,
  type DetailTarget,
} from "@/lib/chat-ui";
import { isAuthDialogOpen, isMenuOpen } from "@/lib/layers";
import { queueDraft, takeQueuedDraft } from "@/lib/queued-draft";
import { queuePendingProfileInvite, takePendingProfileInvite } from "@/lib/pending-invite";
import { profileCardMessageId } from "@/lib/profile-card-id";
import {
  closeAuthDialog,
  openAuthDialog,
  useAuthDialogOpen,
  useOpenAuthDialogOnError,
} from "@/lib/auth-dialog";
import {
  clearGuestSession,
  deleteConversation as deleteConversationAction,
  renameConversation as renameConversationAction,
  sendMessage as sendMessageAction,
  startConversation as startConversationAction,
} from "@/app/actions";

// The live chat surface: useChat message parts fed by the Trigger transport. Every turn - including turn 1
// on arrival - rides the same public send path (useChat.sendMessage -> the transport's sendMessages). Only
// the boundary differs: PROD gates via the sendMessage action; E2E's mock streams a scripted answer.

export function ChatClient({
  conversationId,
  title,
  initialMessages,
  pendingQuestion,
  newChat = false,
  e2e = false,
  signedIn: signedInInitial = false,
  accountName,
  accountEmail,
  conversations: conversationsInitial = [],
  profileOnArrival = false,
  fromAuth = false,
  hasProfile = false,
}: {
  conversationId: string;
  title?: string;
  initialMessages: UIMessage[];
  /** Arrival: the landing/new-chat question (`?q=`), delivered on mount through the same public send path (turn 1 rides useChat.sendMessage). */
  pendingQuestion?: string;
  /** A fresh chat shell (`/chat/new`) - the first send starts a new conversation (arms `freshChatRef`). */
  newChat?: boolean;
  e2e?: boolean;
  signedIn?: boolean;
  accountName?: string;
  accountEmail?: string;
  conversations?: Pick<Conversation, "id" | "title" | "created_at">[];
  profileOnArrival?: boolean;
  /** A genuine post-auth return (`/auth/complete` set `?fromAuth=1`) - ONLY such an arrival may replay a
   *  queued draft; a later ordinary signed-in mount that finds a stale (shared "/chat/new") key must not auto-send it. */
  fromAuth?: boolean;
  /** SSR-resolved: the returning account already has a completed profile. On the post-auth arrival this
   *  skips the form and auto-continues the queued fit question directly. */
  hasProfile?: boolean;
}) {
  const router = useRouter();
  const transport = useJobChatTransport({ e2e, conversationId });
  // Resume a mid-stream reload: a still-streaming persisted session drives reconnectToStream on mount (a settled one leaves this false). Read once (SSR-guarded).
  const [resume] = useState(() => persistedSessionIsStreaming(conversationId));
  const {
    messages,
    sendMessage,
    stop,
    status,
    error,
    regenerate,
    setMessages,
  } = useChat({
    id: conversationId,
    transport,
    messages: initialMessages,
    resume,
  });

  const [draft, setDraft] = useState("");
  const [titleState, setTitleState] = useState(title);
  // Arms the next send to start a brand-new conversation (the landing handoff), not a follow-up. A ref (not
  // state) - it only steers the imperative send path. Seeded from `newChat` so a `/chat/new` shell is armed from mount.
  const freshChatRef = useRef(newChat);
  // Bumped on New chat to move focus to the composer (Composer watches this).
  const [focusNonce, setFocusNonce] = useState(0);
  const [usedFollowups, setUsedFollowups] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  // Auth is client-driven after mount: seeds from the SSR resolve, then an in-page sign-in/sign-out flips it.
  const [signedIn, setSignedIn] = useState(signedInInitial);
  const [conversations, setConversations] = useState(conversationsInitial);
  // Reentrancy guard: while a turn is in flight a second `send` is ignored - without it a follow-up chip clicked
  // mid-stream fires a concurrent send that drops the in-flight optimistic bubble. A ref so the check reads current synchronously.
  const sendingRef = useRef(false);
  const dialogOpen = useAuthDialogOpen();
  useOpenAuthDialogOnError(); // a Google redirect error (?error=) opens the dialog so it can be surfaced
  // Instant "answering" feedback set the moment a turn is sent, to bridge the run-wake gap before the SDK moves
  // `status` off "ready". `pending = isStreaming(status) || awaiting`; the send/attach `finally` clears it, never stuck.
  const [awaiting, setAwaiting] = useState(false);
  const started = useRef(false);
  // Cold-start warm: once per mount, warm the Trigger session for the conversation the
  // first send will use, so the agent's boot overlaps mount/typing rather than stacking after the send.
  // Skipped where it would be junk or pointless: e2e (the mock owns no session), a `/chat/new` shell (its id
  // is a placeholder the first send discards when it mints the real conversation), and a resuming mount
  // (already live). Ref-guarded so a re-render / StrictMode double-invoke never double-warms. `preload` runs
  // the SDK's startSession (createStartSessionAction) - a Trigger session only, so it writes no PG row.
  const preloaded = useRef(false);
  useEffect(() => {
    if (preloaded.current) return;
    preloaded.current = true;
    if (e2e || newChat || resume) return;
    void transport.preload?.(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Auto-continue: the fit question an invite card interrupted. Armed ONLY when an invite is the trailing
  // assistant turn at the moment the profile flow starts; consumed exactly once (nulled BEFORE the send).
  const autoContinueRef = useRef<string | null>(null);
  // Latest turns for the arm-time trailing-card read, so the arm helper stays a stable ([]) callback (no memo
  // churn). Synced in an effect (post-commit), which is always before an event-handler/microtask arm reads it.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // The open detail panel, held by identity so its body re-resolves from the immutable payload (a resume renders the same detail panel). One at a time.
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [profileOpen, setProfileOpen] = useState(profileOnArrival);
  const openDetailPanel = useCallback((messageId: string, partId: string) => {
    setProfileOpen(false);
    setDetailTarget({ messageId, partId });
  }, []);
  const closeDetailPanel = useCallback(() => setDetailTarget(null), []);
  const openProfile = useCallback(() => {
    setDetailTarget(null);
    setProfileOpen(true);
  }, []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  // Abandon-clear (single home): ANY profile-panel close that is NOT a save clears the one-shot ref, so a
  // later save can never fire a stale question. This covers every close path off one flag - the X button
  // (closeProfile), Esc (the window handler), New chat (startNewChat), and switching to a detail panel - which
  // all set `profileOpen=false`. A SAVE keeps the panel open (the saved state), so `onProfileSaved` still reads
  // the armed ref before this ever runs.
  useEffect(() => {
    if (!profileOpen) autoContinueRef.current = null;
  }, [profileOpen]);

  // Arm the one-shot replay IF an invite card is the trailing assistant turn right now (the invite
  // interrupted a fit question). Capture that question; a non-invite trailing card (an Edit from the profile
  // card, the title-bar profile entry) leaves the ref untouched, so those never auto-continue.
  const armAutoContinue = useCallback(() => {
    const msgs = messagesRef.current;
    const trailing = msgs[msgs.length - 1];
    if (!trailing || trailing.role !== "assistant") return;
    const isInviteTrailing = dataParts(trailing).some((p) => {
      const kind = classifyCardData(p.data).kind;
      return kind === "auth-invite" || kind === "profile-invite";
    });
    if (!isInviteTrailing) return;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const question = lastUser ? messageText(lastUser).trim() : "";
    autoContinueRef.current = question || null;
  }, []);

  const onAuthInvite = useCallback(() => {
    if (signedIn) {
      armAutoContinue(); // a signed-in click on an auth-invite opens the form in place - continue the fit question after the save
      openProfile();
      return;
    }
    queuePendingProfileInvite(conversationId);
    openAuthDialog();
  }, [signedIn, conversationId, openProfile, armAutoContinue]);

  // Opening the profile from a card/invite: arm the auto-continue when an INVITE is trailing (a no-op for
  // the profile-card/postings Edit, whose trailing card is not an invite). The title bar opens via openProfile directly (no arm).
  const onEditProfile = useCallback(() => {
    armAutoContinue();
    openProfile();
  }, [armAutoContinue, openProfile]);

  // New chat starts fresh IN PLACE - clear the thread/detail panel/composer without navigating; `freshChatRef` arms the next send to create a brand-new conversation.
  const startNewChat = useCallback(() => {
    freshChatRef.current = true;
    setMessages([]);
    setDetailTarget(null);
    setProfileOpen(false);
    setDraft("");
    setFailed(null);
    setTitleState(undefined); // title bar returns to the "New chat" empty state
    setFocusNonce((n) => n + 1);
  }, [setMessages]);

  // The polite cap/budget notice, rendered as a data-refusal turn (the one MessageList path shows it). A guest
  // cap flips the derived `capped` state below; it does NOT auto-open the dialog - the card + a queued send invite it.
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

  const failSend = useCallback((text: string) => {
    setFailed(text);
    setDraft(text);
  }, []);

  // A guest is "capped" once a guest_cap refusal is in the thread. Derived from messages (no separate state): New chat uncaps, sign-in uncaps.
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
      // While capped, a send queues the draft (composer + sessionStorage, surviving the Google redirect) and opens the dialog; the post-auth mount auto-sends it.
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

      // The first message after New chat starts a NEW conversation, then soft-navigates carrying `?q=` - the new
      // page delivers turn 1 on arrival. Awaiting stays set through the navigation; a refusal clears it and shows the notice.
      if (freshChatRef.current) {
        try {
          if (e2e) {
            router.push(`/chat/${crypto.randomUUID()}?q=${encodeURIComponent(text)}`);
            return;
          }
          const r = await startConversationAction(text);
          if (r.ok) {
            freshChatRef.current = false;
            router.push(`/chat/${r.conversationId}?q=${encodeURIComponent(text)}`);
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

      // Optimistic echo: the user's bubble enters the view NOW (before the round trip). On the happy path
      // sendMessage({messageId}) REPLACES this exact id in place (reconcileMessagesById backstops any duplicate); a refusal/failure rolls it back.
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
          // Mock streams the scripted turn; a Stop-abort rejects here and is expected (no toast).
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
            rollbackEcho(); // a refused send is not shown as sent
            if (r.reason === "guest_cap" || r.reason === "daily_budget") {
              showRefusal(r.reason, text);
              return;
            }
            failSend(text); // invalid_input / not_found -> toast + preserved draft
            return;
          }
          // DELIVER + WATCH via the transport's `sendMessages` (useChat.sendMessage): one primitive appends the
          // turn to `.in` (triggers the run) AND subscribes with wait - the only SDK 4.5.4 path that streams a
          // freshly-triggered follow-up live (`resumeStream` forces peekSettled, so it would read the settled prior
          // turn instead). Passing `messageId` reconciles with the optimistic bubble, so the user turn renders once.
          await sendMessage({ text, messageId: userMessageId });
        } catch {
          rollbackEcho(); // a failed send returns to the composer (toast + draft), not a stuck bubble
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

  // Fire the armed one-shot fit question. Null the ref BEFORE the send so a double-fire can never send
  // twice; `send` still enforces the reentrancy + cap guards. One home for both firing sites: a profile save
  // and the profile-already-on-file post-auth auto-continue.
  const fireAutoContinue = useCallback(() => {
    const question = autoContinueRef.current;
    autoContinueRef.current = null;
    if (question) void send(question);
  }, [send]);

  // The profile card is out-of-band: the task persists it under a DETERMINISTIC id, and the form injects it
  // into the LIVE thread under the SAME id, so a re-save REPLACES the one card (reconcileMessagesById folds by id).
  const onProfileSaved = useCallback(
    async (profile: Profile) => {
      const id = await profileCardMessageId(conversationId);
      const card = {
        id,
        role: "assistant",
        parts: [{ type: "data-profile-card", id: `${id}-card`, data: { kind: "profile-card", profile } }],
      } as UIMessage;
      setMessages((prev) => (prev.some((m) => m.id === id) ? prev.map((m) => (m.id === id ? card : m)) : [...prev, card]));
      // If an invite started this flow, re-run the fit question it interrupted.
      fireAutoContinue();
    },
    [conversationId, setMessages, fireAutoContinue],
  );

  // Arrival: deliver turn 1 through the public send path. Message #1 was SSR-loaded into initialMessages;
  // delivering with its id reconciles the streamed turn onto the SSR bubble (one bubble) and keeps the count-persist a no-op.
  const deliverArrival = useCallback(
    async (question: string) => {
      const seed = initialMessages[initialMessages.length - 1];
      // A settled thread (trailing assistant) is already answered - never re-deliver (defensive).
      if (seed && seed.role !== "user") return;
      const messageId = seed?.role === "user" ? seed.id : undefined;
      sendingRef.current = true;
      setAwaiting(true); // instant answering indicator through the run-wake gap (bubble already present)
      try {
        await sendMessage({ text: question, messageId });
      } catch {
        // stream aborted (Stop) or a mock/stream error - the live error card renders from useChat error
      } finally {
        sendingRef.current = false;
        setAwaiting(false);
      }
    },
    [initialMessages, sendMessage],
  );

  // Arrival kick, run once on mount: turn 1 is delivered via the send path when `?q=` arrived; a mid-stream
  // reload resumes via the persisted session instead. Deferred off the effect body (the send sets state).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    queueMicrotask(() => {
      if (pendingQuestion && !resume) {
        void deliverArrival(pendingQuestion);
        // Strip ?q= so a later reload can't re-deliver turn 1 (it resumes via the persisted session). router.replace soft-navigates - state + stream survive.
        router.replace(`/chat/${conversationId}`);
      }
      // A capped guest's draft queued before the Google redirect carries across via sessionStorage; take-and-clear
      // it on any signed-in mount (the shared "/chat/new" key could be stale), but only SEND on a genuine post-auth arrival (fromAuth).
      else if (signedIn) {
        const queued = takeQueuedDraft(conversationId);
        const pendingInvite = takePendingProfileInvite(conversationId);
        if (queued && fromAuth) void send(queued);
        // This is the guest continuation of onAuthInvite across the redirect - arm the fit question the
        // SSR thread's trailing invite interrupted. If a profile is ALREADY on file, skip the form and
        // auto-continue the queued fit question NOW; otherwise the form opens and the save fires it.
        else if (pendingInvite && fromAuth) {
          armAutoContinue();
          if (hasProfile) fireAutoContinue();
          else openProfile();
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFollowup = useCallback(
    (cardId: string, text: string) => {
      // One-shot - mark this card's chip used (stays disabled) and send its text as the next turn.
      setUsedFollowups((prev) => new Set(prev).add(`${cardId}::${text}`));
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

  // Ref-stable so `React.memo(AssistantMessage)` can bail on settled turns (an inline lambda would be a fresh ref each render and defeat the memo).
  const onRetry = useCallback(() => void regenerate(), [regenerate]);

  // Stop pairs the transport's backend signal with the SDK stop: after a resumed mount `useChat.stop()` aborts
  // only the local reader (the SDK doesn't thread an abort through reconnectToStream), so without `stopGeneration` the backend keeps generating.
  const onStop = useCallback(() => {
    void transport.stopGeneration(conversationId);
    void stop();
  }, [transport, conversationId, stop]);

  // Sign out: drop the Better Auth session, then land on the LANDING as a guest. On success: reset the sidebar,
  // clear the open thread + history, rotate the guest cookie, redirect to "/". A failed sign-out leaves the session in place (no data loss).
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

  // Delete a conversation from the sidebar (the action re-checks ownership): drop it from the list, and if it's the OPEN one clear to the fresh-chat state. A refusal leaves the list untouched.
  const onDeleteConversation = useCallback(
    async (id: string) => {
      const r = await deleteConversationAction(id);
      if (!r.ok) return;
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === conversationId) startNewChat();
    },
    [conversationId, startNewChat],
  );

  // Rename a conversation from the sidebar (the action re-checks ownership + trims/caps the title): patch the
  // list to the STORED title, and if it's the OPEN one update the title bar too. A refusal leaves both untouched.
  const onRenameConversation = useCallback(
    async (id: string, title: string) => {
      const r = await renameConversationAction(id, title);
      if (!r.ok) return;
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: r.title } : c)));
      if (id === conversationId) setTitleState(r.title);
    },
    [conversationId],
  );

  // Reconcile by id at the merge seam: reconnecting to a live run re-receives the already-present assistant tail
  // (SDK session replay, same id); fold those duplicates (replace in place, order kept) so each turn renders once and keys stay unique.
  // Then dedupeInviteCards: the idempotent invite cards arrive from uncoordinated sources under DIFFERENT ids, so only a presentation pass collapses them.
  const view = useMemo(() => dedupeInviteCards(reconcileMessagesById(messages)), [messages]);

  // The open detail panel's body, re-resolved from the current (immutable) messages. The EXPENSIVE resolve (classify +
  // Zod safeParse -> a fresh insight whose new `rows` ref re-sorts the DataTable) is memoized on the target
  // message's REF, not the whole `view` array - so a detail panel left open during an unrelated stream doesn't re-parse per chunk.
  const targetMessage = detailTarget
    ? (view.find((m) => m.id === detailTarget.messageId) ?? null)
    : null;
  const detailContent = useMemo(
    () =>
      targetMessage && detailTarget
        ? resolveDetailContent([targetMessage], detailTarget)
        : null,
    [targetMessage, detailTarget],
  );

  // Close-on-Esc, honoring the layer priority (dialog > menu > detail panel): yield while `isAuthDialogOpen()` or
  // `isMenuOpen()` is true; otherwise Esc closes the detail panel. Bound once; the functional setState reads current.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (isAuthDialogOpen() || isMenuOpen()) return; // a layer above the detail panel consumes Esc first
      // Close whichever detail panel view is open (they are mutually exclusive).
      setProfileOpen(false);
      setDetailTarget((t) => (t ? null : t));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // `pending` = streaming OR the pre-stream run-wake gap. Drives BOTH the composer state and the MessageList
  // answering indicator off one flag (indicator + Stop stay in lockstep). Capped keeps the composer ENABLED with its register placeholder.
  const pending = isStreaming(status) || awaiting;
  // A turn that errors at the SDK level surfaces on useChat's `error` but streams NO data-error part, so feed
  // the error state through for the live error card + Retry (regenerate clears `error`, so the card drops once Retry runs).
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
        onRenameConversation={(id, title) => void onRenameConversation(id, title)}
      />
      <main className="main">
        {/* The detail panel takes the middle of the canvas (table OR profile); the chat docks to the right rail. */}
        {profileOpen ? (
          <ProfilePanel
            conversationId={conversationId}
            e2e={e2e}
            onClose={closeProfile}
            onFindJob={() => void send("Find me a job that fits")}
            onProfileSaved={onProfileSaved}
          />
        ) : detailContent ? (
          <DetailPanel content={detailContent} onClose={closeDetailPanel} />
        ) : null}
        <div className={profileOpen || detailContent ? "canvas docked" : "canvas"}>
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
              usedFollowups={usedFollowups}
              onFollowup={onFollowup}
              onRetry={onRetry}
              onOpenDetailPanel={openDetailPanel}
              onSignIn={signedIn ? undefined : openAuthDialog}
              onEditProfile={onEditProfile}
              onAuthInvite={onAuthInvite}
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
        // Send-failure toast with Retry; no design token exists for a toast, so it is styled inline from theme variables.
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
      {/* Topmost layer (auth dialog > detail panel > thread). Sign-in from inside a chat returns to THIS conversation. */}
      {dialogOpen ? (
        <AuthDialog
          onClose={closeAuthDialog}
          next={`/chat/${conversationId}`}
        />
      ) : null}
    </div>
  );
}
