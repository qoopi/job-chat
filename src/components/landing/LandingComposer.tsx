"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SendIcon } from "@/components/icons";
import { RefusalNotice } from "@/components/insight/ErrorCard";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { closeAuthDialog, openAuthDialog, useAuthDialogOpen } from "@/lib/auth-dialog";
import { ensureGuest, startConversation } from "@/app/actions";
import type { RefusalReason } from "@/lib/insight-format";

// The landing hero's interactive part (mock 4b): the ask box + intent chips that hand off to the chat
// with the stream already attached on arrival (AC-3, interaction-spec section 7). On first paint it
// mints the guest cookie (AC-12). PROD posts the question to `startConversation`; a guest cap refusal
// is now VISIBLE here (AC-13 - no silent refusal): a polite notice + a sign-in affordance that opens the
// lazy dialog and queues the blocked question for auto-continuation on success (interaction-spec s6/s7).
// This component also hosts the one landing auth dialog (the header "Sign in" opens it via the shared
// store). E2E skips the Bedrock-backed action and carries the question in the URL.
const CHIPS = [
  "Find me a job that fits",
  "Median salary for a Data Engineer in SF",
  "Top companies hiring right now",
];

export function LandingComposer({ e2e = false }: { e2e?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Extract<RefusalReason, "guest_cap" | "daily_budget"> | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const dialogOpen = useAuthDialogOpen();

  // AC-12: a first-time visitor gets a guest cookie (+ users row in prod) as soon as they arrive.
  useEffect(() => {
    void ensureGuest();
  }, []);

  async function submit(question: string, opts?: { fromAuth?: boolean }) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      if (e2e) {
        router.push(`/chat/${crypto.randomUUID()}?new=1&q=${encodeURIComponent(text)}`);
        return;
      }
      const r = await startConversation(text);
      if (r.ok) {
        router.push(`/chat/${r.conversationId}?new=1`);
        return;
      }
      if (r.reason === "guest_cap" || r.reason === "daily_budget") {
        setRefusal(r.reason);
        setDraft(text); // the blocked question stays in the box (survives the dialog / cancel)
        if (r.reason === "guest_cap" && !opts?.fromAuth) {
          setQueued(text); // queue for auto-continuation once sign-in succeeds
          openAuthDialog();
        }
      }
      setBusy(false); // refusal / invalid - let the visitor edit and retry
    } catch {
      setBusy(false);
    }
  }

  // AC-11: sign-in succeeded (adoption + guest-cookie clear ran in the dialog). Continue the queued
  // question through the normal path (fromAuth, so a still-refusing signed-in cap just shows the notice).
  function onAuthSuccess() {
    closeAuthDialog();
    const q = queued;
    setQueued(null);
    if (q) void submit(q, { fromAuth: true });
  }

  const inputDisabled = busy || dialogOpen;

  return (
    <>
      <div style={{ width: "100%", maxWidth: 560, marginTop: 10 }}>
        <div className="input-bar focused" style={{ padding: "12px 12px 12px 18px" }}>
          <textarea
            rows={1}
            aria-label="What are you looking for"
            placeholder="What are you looking for?"
            value={draft}
            disabled={inputDisabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(draft);
              }
            }}
          />
          <button
            className="send"
            type="button"
            aria-label="Send"
            style={{ width: 38, height: 38 }}
            onClick={() => void submit(draft)}
          >
            <SendIcon size={16} />
          </button>
        </div>
      </div>
      {refusal ? (
        <div style={{ width: "100%", maxWidth: 560, display: "flex", justifyContent: "center" }}>
          <RefusalNotice reason={refusal} onSignIn={openAuthDialog} />
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", maxWidth: 640 }}>
        {CHIPS.map((c) => (
          <button
            key={c}
            className="chip"
            type="button"
            disabled={inputDisabled}
            style={{ background: "transparent", borderColor: "var(--shell-border)", color: "var(--shell-fg)" }}
            onClick={() => void submit(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {dialogOpen ? <AuthDialog onClose={closeAuthDialog} onSuccess={onAuthSuccess} /> : null}
    </>
  );
}
