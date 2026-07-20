"use client";

import { openAuthDialog } from "@/lib/auth-dialog";

// The landing header "Sign in" (interaction-spec s7: opens the auth dialog on the landing page itself).
// It only triggers the shared open-store; the one landing dialog is rendered by LandingComposer.
export function LandingSignIn() {
  return (
    <button className="btn btn-shell btn-sm" type="button" onClick={() => openAuthDialog()}>
      Sign in
    </button>
  );
}
