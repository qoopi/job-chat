"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { openAuthDialog } from "@/lib/auth-dialog";
import { clearGuestSession } from "@/app/actions";
import { AccountMenu } from "@/components/chat/AccountMenu";

// The landing header's auth affordance (session seeded from the server resolve). Guest -> "Sign in" (opens the
// dialog); signed-in -> "Open your chats" + the account menu. Sign-out flips to guest IN PLACE (no navigation).
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
