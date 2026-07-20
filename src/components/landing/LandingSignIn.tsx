"use client";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { openAuthDialog } from "@/lib/auth-dialog";
import { clearGuestSession } from "@/app/actions";

// The landing header's auth affordance (interaction-spec s7). The session is read server-side (the landing
// page resolves it via resolveViewer) and seeded here (017 fix round 2):
//  - Guest -> "Sign in", which opens the lazy auth dialog (the one landing dialog is rendered by
//    LandingComposer via the shared open-store). Unchanged.
//  - Signed-in -> the account name + "Open chat" (into /chat/new, the fresh chat shell) + Sign out.
// Sign-out mirrors the sidebar's (Better Auth signOut + rotate the guest cookie) but STAYS on the landing
// and flips the header to guest IN PLACE - no navigation. Minimal markup now; the design refresh polishes.

// The small text-link "Sign out" (mirrors the sidebar foot's tokens - shell-dim, tiny).
const signOutStyle: CSSProperties = {
  padding: 0,
  border: 0,
  background: "none",
  font: "inherit",
  fontSize: "var(--fs-xs)",
  color: "var(--shell-fg-dim)",
  cursor: "pointer",
};

export function LandingSignIn({
  signedIn: signedInInitial = false,
  accountName,
}: {
  signedIn?: boolean;
  accountName?: string;
}) {
  // Seeded from the server resolve; a client sign-out flips it to guest in place (stay on the landing).
  const [signedIn, setSignedIn] = useState(signedInInitial);

  if (!signedIn) {
    return (
      <button className="btn btn-shell btn-sm" type="button" onClick={() => openAuthDialog()}>
        Sign in
      </button>
    );
  }

  async function onSignOut() {
    await authClient
      .signOut({
        fetchOptions: {
          onSuccess: () => {
            setSignedIn(false); // flip the header to guest in place - no navigation, stay on the landing
            void clearGuestSession(); // rotate the guest cookie so the next visit starts fresh (sidebar parity)
          },
        },
      })
      .catch(() => {
        /* a failed sign-out leaves the session in place - no data loss */
      });
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <span style={{ fontSize: "var(--fs-sm)", color: "var(--shell-fg)" }}>{accountName ?? "Account"}</span>
      <Link className="btn btn-shell btn-sm" href="/chat/new">
        Open chat
      </Link>
      <button type="button" onClick={() => void onSignOut()} style={signOutStyle}>
        Sign out
      </button>
    </div>
  );
}
