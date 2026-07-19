"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SendIcon } from "@/components/icons";
import { ensureGuest, startConversation } from "@/app/actions";

// The landing hero's interactive part (mock 4b): the ask box + intent chips that hand off to the chat
// with the stream already attached on arrival (AC-3, interaction-spec section 7). On first paint it
// mints the guest cookie (AC-12) - a Server Component cannot set a cookie during render, so the guest
// is ensured here via the action. PROD posts the question to `startConversation` (creates the
// conversation + user message #1 and triggers the run) then routes to it. E2E skips the Bedrock-backed
// action and carries the question in the URL, where the mock-transport chat page streams it.
const CHIPS = [
  "Find me a job that fits",
  "Median salary for a Data Engineer in SF",
  "Top companies hiring right now",
];

export function LandingComposer({ e2e = false }: { e2e?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // AC-12: a first-time visitor gets a guest cookie (+ users row in prod) as soon as they arrive.
  useEffect(() => {
    void ensureGuest();
  }, []);

  async function submit(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      if (e2e) {
        router.push(`/chat/${crypto.randomUUID()}?new=1&q=${encodeURIComponent(text)}`);
        return;
      }
      const r = await startConversation(text);
      if (r.ok) router.push(`/chat/${r.conversationId}?new=1`);
      else setBusy(false); // refusal/invalid - let the visitor edit and retry
    } catch {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ width: "100%", maxWidth: 560, marginTop: 10 }}>
        <div className="input-bar focused" style={{ padding: "12px 12px 12px 18px" }}>
          <textarea
            rows={1}
            aria-label="What are you looking for"
            placeholder="What are you looking for?"
            value={draft}
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
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", maxWidth: 640 }}>
        {CHIPS.map((c) => (
          <button
            key={c}
            className="chip"
            type="button"
            style={{ background: "transparent", borderColor: "var(--shell-border)", color: "var(--shell-fg)" }}
            onClick={() => void submit(c)}
          >
            {c}
          </button>
        ))}
      </div>
    </>
  );
}
