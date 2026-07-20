"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { completeSignIn } from "@/app/actions";
import { GoogleIcon } from "@/components/icons";

// Focusable descendants of the dialog, in DOM order - the ring the modal contains Tab within.
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// The lazy auth dialog (interaction-spec s6, mock 3a/5a). Opens ONLY on demand (Sign in tap or the cap
// moment - never on load), sits topmost (dialog > LCP > thread), and closes on cancel / Esc / backdrop
// with the chat untouched. Google + email/password (Better Auth client); on a successful in-page
// sign-in it runs the sign-in TRANSITION (`completeSignIn`: adopt the guest's conversations onto the
// account and clear the guest cookie so per-request resolution stops re-adopting - decision-log ruling)
// BEFORE handing control back to the host via `onSuccess` (which auto-sends any queued draft / refreshes
// history). Google is a redirect: its success reloads the page, so its continuation rides the server
// per-request path, not `onSuccess`.

export function AuthDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess?: (accountName?: string) => void;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    node.querySelector<HTMLElement>("#auth-email")?.focus(); // initial focus lands inside the dialog

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
      opener?.focus?.(); // restore focus to the opener on close (cancel / Esc / backdrop / success)
    };
  }, []);

  async function succeed() {
    // The sign-in transition (adoption + guest-cookie clear, server-side) returns the account's display
    // name for a fresh sidebar. `{ok:false}` means the session is not yet visible server-side: keep the
    // dialog open with an inline error and DO NOT fire onSuccess (no auto-send, draft intact).
    const { ok, name } = await completeSignIn();
    if (!ok) {
      setError("We couldn't finish signing you in. Try again.");
      return;
    }
    onSuccess?.(name);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res =
        mode === "signup"
          ? await authClient.signUp.email({ email, password, name: email.split("@")[0] || email })
          : await authClient.signIn.email({ email, password });
      if (res?.error) {
        setError(res.error.message ?? "That did not work. Check your details.");
        return;
      }
      await succeed();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function onGoogle() {
    setError(null);
    try {
      // Redirect flow: returns to the current page signed in; the per-request path finishes adoption.
      await authClient.signIn.social({ provider: "google", callbackURL: window.location.href });
    } catch {
      setError("Google sign-in is unavailable right now.");
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

        <button className="btn btn-outline btn-block" type="button" onClick={() => void onGoogle()} disabled={loading}>
          <GoogleIcon />
          Continue with Google
        </button>

        <div className="divider">or</div>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className={error ? "field invalid" : "field"}>
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error ? <span className="field-error">{error}</span> : null}
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner" />
                Signing in…
              </>
            ) : mode === "signup" ? (
              "Create account"
            ) : (
              "Continue"
            )}
          </button>
        </form>

        <div className="dialog-note">
          {mode === "signin" ? (
            <>
              New here?{" "}
              <button type="button" onClick={() => { setMode("signup"); setError(null); }}>
                Create an account
              </button>{" "}
              &middot;{" "}
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </>
          ) : (
            <>
              Have an account?{" "}
              <button type="button" onClick={() => { setMode("signin"); setError(null); }}>
                Sign in
              </button>{" "}
              &middot;{" "}
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
