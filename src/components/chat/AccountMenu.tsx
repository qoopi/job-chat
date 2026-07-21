"use client";

import { useEffect, useRef, useState } from "react";
import { MoonIcon, PersonIcon, SignOutIcon } from "@/components/icons";
import { isAuthDialogOpen, setMenuOpen } from "@/lib/layers";
import { useTheme } from "@/lib/theme";

// refresh #2 s4: the signed-in account affordance, VISIBLE in the title bar (the old bottom-left foot
// was "hard to locate"). A chip - avatar + first name + caret - toggles a dropdown anchored top-right:
//  1. header: email + muted "Personal account"
//  2. "Your profile" -> opens the profile in the LCP (s7)
//  3. "Dark mode" + a pill toggle (theme persisted via the cookie - s4)
//  4. "Sign out" (danger) -> ends the session and lands on the landing (s6)
// The menu closes on outside click / Esc, and sits BELOW the auth dialog in layer priority (it yields
// Esc while the dialog is open). Shared by the chat title bar and the landing header (s10).
export function AccountMenu({
  accountName,
  email,
  onOpenProfile,
  onSignOut,
}: {
  accountName?: string;
  email?: string;
  onOpenProfile: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const name = (accountName ?? "Account").trim();
  const firstName = name.split(/\s+/)[0] || "Account";
  const initial = name[0]?.toUpperCase() ?? "A";
  const dark = theme === "Dark";

  // Publish the menu's open state to the layer seam (ruling 4) so the LCP's Esc handler yields while the
  // menu is up (Esc order: dialog > menu > LCP). Reset on close/unmount so the flag never sticks true.
  useEffect(() => {
    setMenuOpen(open);
    return () => setMenuOpen(false);
  }, [open]);

  // Close on outside click / Esc while open. Below the dialog in layer priority: yield Esc while the
  // auth dialog is up (the dialog's own handler also stops propagation, so this is order-independent).
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isAuthDialogOpen()) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="account" ref={ref}>
      <button
        className="account-chip"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="account-avatar">{initial}</span>
        <span className="account-name">{firstName}</span>
        <span className="account-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        // A disclosure popover of buttons (not an ARIA menu widget - no roving-tabindex/arrow-key model
        // to half-implement); the chip carries aria-expanded + aria-haspopup.
        <div className="account-menu">
          <div className="account-menu-head">
            <div className="account-menu-email">{email ?? name}</div>
            <div className="account-menu-sub">Personal account</div>
          </div>
          <button
            className="account-menu-item"
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenProfile();
            }}
          >
            <PersonIcon />
            <span className="account-menu-label">Your profile</span>
          </button>
          <button
            className="account-menu-item"
            type="button"
            aria-pressed={dark}
            onClick={toggleTheme}
          >
            <MoonIcon />
            <span className="account-menu-label">Dark mode</span>
            <span className={dark ? "toggle on" : "toggle"} aria-hidden>
              <span className="toggle-knob" />
            </span>
          </button>
          <button
            className="account-menu-item danger"
            type="button"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <SignOutIcon />
            <span className="account-menu-label">Sign out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
