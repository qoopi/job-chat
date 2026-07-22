"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { SendIcon } from "@/components/icons";
import { RefusalNotice } from "@/components/insight/ErrorCard";
import {
  closeAuthDialog,
  openAuthDialog,
  useAuthDialogOpen,
  useOpenAuthDialogOnError,
} from "@/lib/auth-dialog";
import { ensureGuest, startConversation } from "@/app/actions";
import { queueDraft } from "@/lib/queued-draft";
import type { RefusalReason } from "@/lib/insight-format";

// Defer the AuthDialog off the landing's initial JS (it pulls authClient) - it loads only when the dialog first opens. Client-only.
const AuthDialog = dynamic(
  () => import("@/components/auth/AuthDialog").then((m) => m.AuthDialog),
  {
    ssr: false,
  },
);

// The landing hero's ask box + intent chips: hand off to the chat carrying the question in `?q=` (turn 1 streams
// on arrival). Mints the guest cookie on first paint; a guest-cap refusal is VISIBLE here (a notice + sign-in).
const CHIPS = [
  "Find me a job that fits",
  "Median salary for a Data Engineer in SF",
  "Top companies hiring right now",
];

export function LandingComposer({ e2e = false }: { e2e?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Extract<
    RefusalReason,
    "guest_cap" | "daily_budget"
  > | null>(null);
  const dialogOpen = useAuthDialogOpen();
  useOpenAuthDialogOnError(); // a Google redirect error (?error=) opens the dialog so it can be surfaced

  // A first-time visitor gets a guest cookie (+ users row in prod) as soon as they arrive.
  useEffect(() => {
    void ensureGuest();
  }, []);

  async function submit(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      if (e2e) {
        router.push(`/chat/${crypto.randomUUID()}?q=${encodeURIComponent(text)}`);
        return;
      }
      const r = await startConversation(text);
      if (r.ok) {
        router.push(`/chat/${r.conversationId}?q=${encodeURIComponent(text)}`);
        return;
      }
      if (r.reason === "guest_cap" || r.reason === "daily_budget") {
        setRefusal(r.reason);
        setDraft(text); // the blocked question stays in the box (survives the dialog / cancel)
        // A guest cap shows the register card (no auto-open, composer stays usable) and stashes the blocked question
        // under "/chat/new" so the post-auth arrival replays it once. Only guest_cap - daily_budget is a hard stop signing in can't lift.
        if (r.reason === "guest_cap") queueDraft("new", text);
      }
      setBusy(false); // refusal / invalid - let the visitor edit and retry
    } catch {
      setBusy(false);
    }
  }

  const inputDisabled = busy || dialogOpen;

  return (
    <>
      <div style={{ width: "100%", maxWidth: 560, marginTop: 10 }}>
        <div
          className="input-bar focused"
          style={{ padding: "12px 12px 12px 18px" }}
        >
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
        <div
          style={{
            width: "100%",
            maxWidth: 560,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <RefusalNotice reason={refusal} onSignIn={openAuthDialog} />
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: 640,
        }}
      >
        {CHIPS.map((c) => (
          <button
            key={c}
            className="chip"
            type="button"
            disabled={inputDisabled}
            style={{
              background: "transparent",
              borderColor: "var(--shell-border)",
              color: "var(--shell-fg)",
            }}
            onClick={() => void submit(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {/* Landing-initiated sign-in lands the user INSIDE the app (a fresh chat shell), not back on "/". */}
      {dialogOpen ? (
        <AuthDialog onClose={closeAuthDialog} next="/chat/new" />
      ) : null}
    </>
  );
}
