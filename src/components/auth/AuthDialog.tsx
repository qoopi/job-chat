"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { GoogleIcon } from "@/components/icons";

// Focusable descendants of the dialog, in DOM order - the ring the modal contains Tab within.
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// The lazy auth dialog (interaction-spec s6, mock 3a/5a). Opens ONLY on demand (Sign in tap or the cap
// moment - never on load), sits topmost (dialog > LCP > thread), and closes on cancel / Esc / backdrop
// with the chat untouched. Google-ONLY (operator ruling 2026-07-21): email/password is removed.
// `signIn.social` is a full-page CLIENT-initiated redirect to Google (gold standard s2.3); on success
// Better Auth lands the browser on the STABLE `/auth/complete` route (which finalizes the sign-in
// server-side), so there is NO in-page success callback - the dialog's job is to START the redirect. On
// failure Better Auth bounces back to this page with `?error=<code>`; we read it on mount and surface it
// here (never a silent reload). The host opens the dialog on `?error=` (useOpenAuthDialogOnError).

/** Map a Google/OAuth redirect error code to a human line. Google-only, so the realistic codes are the
 *  callback failures (cookie/state loss, an unlinkable account); anything else gets the generic retry. */
function googleErrorMessage(code: string): string {
  switch (code) {
    case "account_not_linked":
      return "This Google account can't be linked to an existing account. Try a different one.";
    case "state_mismatch":
      return "Your sign-in link expired. Please try again.";
    default:
      return "Google sign-in didn't complete. Please try again.";
  }
}

// `next` is the post-sign-in destination the HOST decides (017 fix round 2): the landing host passes
// `/chat/new` (sign-in takes the user INTO the app), a chat host passes its own conversation path (sign-in
// returns to that chat). It flows through /auth/complete's resolve-then-compare-origin safeNext guard, so
// it must stay a same-origin path. Falls back to the current page for any host that omits it.
export function AuthDialog({ onClose, next }: { onClose: () => void; next?: string }) {
  // Seed the error from a Google redirect's `?error=<code>` (Better Auth's errorCallbackURL bounced the
  // browser back here). Read in the initializer, not an effect: the dialog only ever mounts client-side
  // (dialogOpen is false on the server), so `window` is defined and there is no SSR flash. The param is
  // stripped by the effect below so a refresh does not re-surface a stale error.
  const [error, setError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("error");
    return code ? googleErrorMessage(code) : null;
  });
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc closes the dialog. As the topmost layer it takes Esc over the LCP, and it does so INDEPENDENTLY
  // of window keydown-listener registration order: `stopImmediatePropagation` suppresses every other
  // window keydown listener (the LCP's Esc handler), so a single Esc closes only the dialog and never
  // falls through to the layer beneath it - whether this listener runs before or after ChatClient's.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Modal a11y (AC-10; engineering.md lists accessibility as never-simplify-away). Move focus INTO the
  // dialog on open, contain Tab within it (a keyboard user must not reach the dimmed shell behind the
  // modal - interaction-spec "Priority of layers"), and restore focus to the opener when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    node.querySelector<HTMLElement>("#auth-google")?.focus(); // initial focus lands inside the dialog

    function onTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    node.addEventListener("keydown", onTab);
    return () => {
      node.removeEventListener("keydown", onTab);
      opener?.focus?.(); // restore focus to the opener on close (cancel / Esc / backdrop)
    };
  }, []);

  // Strip the surfaced `?error=` from the URL (the message is already seeded above) so a refresh /
  // re-mount does not re-surface a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("error")) return;
    params.delete("error");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  }, []);

  async function onGoogle() {
    setError(null);
    setLoading(true);
    try {
      // Full-page CLIENT-initiated redirect (gold standard s2.3). STABLE callbackURL (a fixed route, not
      // window.location.href) that finalizes the sign-in and lands the user on the HOST-decided `next`
      // (landing -> /chat/new; a chat -> that chat); errorCallbackURL returns to THIS page so the ?error
      // handler above can show what failed. Fall back to the current page when a host omits `next`.
      const dest = next ?? window.location.pathname + window.location.search;
      await authClient.signIn.social({
        provider: "google",
        callbackURL: `/auth/complete?next=${encodeURIComponent(dest)}`,
        errorCallbackURL: window.location.pathname,
      });
    } catch {
      setError("Google sign-in is unavailable right now.");
      setLoading(false);
    }
  }

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Sign in to jobchat.dev"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Sign in to jobchat.dev</h3>
        <p className="sub">Keep your profile, matches and history.</p>

        <button
          id="auth-google"
          className="btn btn-outline btn-block"
          type="button"
          onClick={() => void onGoogle()}
          disabled={loading}
        >
          <GoogleIcon />
          Continue with Google
        </button>

        {error ? (
          <p className="field-error" role="alert" style={{ marginTop: "var(--sp-3)" }}>
            {error}
          </p>
        ) : null}

        <div className="dialog-note">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
