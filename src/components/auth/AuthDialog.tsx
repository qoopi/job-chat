"use client";

import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { completeSignIn } from "@/app/actions";
import { GoogleIcon } from "@/components/icons";

// The lazy auth dialog (interaction-spec s6, mock 3a/5a). Opens ONLY on demand (Sign in tap or the cap
// moment - never on load), sits topmost (dialog > LCP > thread), and closes on cancel / Esc / backdrop
// with the chat untouched. Google + email/password (Better Auth client); on a successful in-page
// sign-in it runs the sign-in TRANSITION (`completeSignIn`: adopt the guest's conversations onto the
// account and clear the guest cookie so per-request resolution stops re-adopting - decision-log ruling)
// BEFORE handing control back to the host via `onSuccess` (which auto-sends any queued draft / refreshes
// history). Google is a redirect: its success reloads the page, so its continuation rides the server
// per-request path, not `onSuccess`.

export function AuthDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess?: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Esc closes the dialog. As the topmost layer it takes Esc over the LCP: the LCP's own keydown handler
  // yields while `isAuthDialogOpen()` (set by the open-store) is true, and this listener - registered
  // when the dialog mounts, i.e. AFTER the LCP's - runs second and closes the dialog, leaving the LCP.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function succeed() {
    await completeSignIn(); // the sign-in transition: adoption + guest-cookie clear (server-side)
    onSuccess?.();
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
