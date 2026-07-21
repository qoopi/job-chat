"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { openAuthDialog } from "@/lib/auth-dialog";
import { clearGuestSession } from "@/app/actions";
import { AccountMenu } from "@/components/chat/AccountMenu";

// The landing header's auth affordance (refresh #2 s10). The session is read server-side (the landing
// page resolves it via resolveViewer) and seeded here:
//  - Guest -> "Sign in", which opens the lazy auth dialog (rendered by LandingComposer via the shared
//    open-store). Unchanged.
//  - Signed-in -> a primary "Open your chats" (-> the most recent conversation, else /chat/new) PLUS the
//    same account chip + menu as the chat title bar (§4): email header, Your profile, Dark mode, Sign out.
// Sign-out mirrors the sidebar's (Better Auth signOut + rotate the guest cookie) but STAYS on the landing
// and flips the header to guest IN PLACE - no navigation. The landing has no LCP, so "Your profile" routes
// into the app (a fresh chat with the profile open).
export function LandingSignIn({
  signedIn: signedInInitial = false,
  accountName,
  accountEmail,
  openChatsHref = "/chat/new",
}: {
  signedIn?: boolean;
  accountName?: string;
  accountEmail?: string;
  openChatsHref?: string;
}) {
  const router = useRouter();
  // Seeded from the server resolve; a client sign-out flips it to guest in place (stay on the landing).
  const [signedIn, setSignedIn] = useState(signedInInitial);

  if (!signedIn) {
    return (
      <button
        className="btn btn-shell btn-sm"
        type="button"
        onClick={() => openAuthDialog()}
      >
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
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Link className="btn btn-primary btn-sm" href={openChatsHref}>
        Open your chats
      </Link>
      <AccountMenu
        accountName={accountName}
        email={accountEmail}
        onOpenProfile={() => router.push("/chat/new?profile=1")}
        onSignOut={() => void onSignOut()}
      />
    </div>
  );
}
