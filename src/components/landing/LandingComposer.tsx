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

// The landing is the first-paint / marketing route where the dialog is rarely opened, so defer the
// AuthDialog (and the Better Auth `authClient` it pulls) off the landing's initial JS - it loads only
// when the dialog first opens. Client-only: the dialog never renders on the server.
const AuthDialog = dynamic(
  () => import("@/components/auth/AuthDialog").then((m) => m.AuthDialog),
  {
    ssr: false,
  },
);

// The landing hero's interactive part (mock 4b): the ask box + intent chips that hand off to the chat,
// carrying the question in `?q=` so turn 1 streams via the public send path on arrival
// (interaction-spec section 7). On first paint it
// mints the guest cookie. PROD posts the question to `startConversation`; a guest cap refusal
// is now VISIBLE here (no silent refusal): a polite notice + a sign-in affordance that opens the
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
        // A guest cap renders the warm register card (RefusalNotice) with a "Create
        // account" button that opens the dialog - no auto-open, so the composer stays usable.
        // Carry the blocked question across Google sign-in exactly like the
        // chat path - stash under the landing dialog's "/chat/new" destination so the post-auth arrival
        // (fromAuth) replays it once. Only guest_cap (the register moment); daily_budget is a hard stop
        // that signing in cannot lift, matching the chat path's guest_cap-only `capped` carry.
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
