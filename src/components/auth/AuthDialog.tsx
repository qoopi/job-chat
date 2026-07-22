"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { GoogleIcon } from "@/components/icons";

// Focusable descendants of the dialog, in DOM order - the ring the modal contains Tab within.
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// The lazy auth dialog: opens on demand, topmost, Google-ONLY. signIn.social is a full-page redirect; on
// success Better Auth lands on /auth/complete (no in-page success callback), on failure it bounces back with ?error= (read + surfaced here).

/** Map a Google OAuth redirect error code to a human line; anything unknown gets the generic retry. */
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

// `next` is the post-sign-in destination the HOST decides (landing -> /chat/new; a chat -> its path). It flows
// through /auth/complete's safeNext guard, so it must stay a same-origin path; falls back to the current page.
export function AuthDialog({
  onClose,
  next,
}: {
  onClose: () => void;
  next?: string;
}) {
  // Seed the error from `?error=<code>` in the initializer (client-only mount, so `window` is defined, no SSR flash); stripped by the effect below.
  const [error, setError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("error");
    return code ? googleErrorMessage(code) : null;
  });
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc closes the dialog. As the topmost layer it uses stopImmediatePropagation to suppress every other
  // window keydown listener (the LCP's Esc handler), so one Esc closes only the dialog - order-independent.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Modal a11y: move focus INTO the dialog, contain Tab within it (no reaching the dimmed shell behind), restore focus to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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

  // Strip the surfaced `?error=` so a refresh doesn't re-surface a stale error (the message is already seeded).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("error")) return;
    params.delete("error");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
  }, []);

  async function onGoogle() {
    setError(null);
    setLoading(true);
    try {
      // Full-page redirect: STABLE callbackURL finalizes the sign-in and lands on the HOST-decided `next`; errorCallbackURL returns HERE so the ?error handler shows failures.
      const dest = next ?? window.location.pathname + window.location.search;
      const res = await authClient.signIn.social({
        provider: "google",
        callbackURL: `/auth/complete?next=${encodeURIComponent(dest)}`,
        errorCallbackURL: window.location.pathname,
      });
      // better-auth RESOLVES with { error } on HTTP failures (it does NOT throw), so check it or the button stays dead in `loading`.
      if (res?.error) {
        setError("Google sign-in is unavailable right now.");
        setLoading(false);
      }
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
        aria-label="Create your free account"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Create your free account</h3>
        <p className="sub">Keep this conversation, your history and profile.</p>

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
          <p
            className="field-error"
            role="alert"
            style={{ marginTop: "var(--sp-3)" }}
          >
            {error}
          </p>
        ) : null}

        <p className="dialog-note">
          Your guest conversation is saved to the new account.
        </p>

        <div className="dialog-note">
          <button type="button" onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
