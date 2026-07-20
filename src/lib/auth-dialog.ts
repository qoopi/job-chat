"use client";

import { useSyncExternalStore } from "react";
import { setAuthDialogOpen } from "@/lib/layers";

// The single source of truth for the lazy auth dialog's open state (interaction-spec s6). A module
// singleton because "only one dialog at a time" (the layer-priority invariant) is global, and the
// dialog is triggered from structurally-separate places - the landing header + composer, and the chat
// sidebar + cap notice. It also DRIVES the Esc layer seam (`layers.ts`): opening flips
// `setAuthDialogOpen` so the LCP's keydown handler yields Esc to the dialog first (dialog > LCP). Each
// page's host (ChatClient / LandingComposer) renders the one dialog when this reads open; only one host
// is ever mounted, so only one dialog renders. Mirrors the existing `layers.ts` singleton pattern.

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Open the lazy auth dialog and yield Esc priority to it over the LCP. Idempotent. */
export function openAuthDialog(): void {
  if (open) return;
  open = true;
  setAuthDialogOpen(true);
  emit();
}

/** Close the dialog (cancel / Esc / backdrop / success) and hand Esc back to the LCP. Idempotent. */
export function closeAuthDialog(): void {
  if (!open) return;
  open = false;
  setAuthDialogOpen(false);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive read of the dialog open state for the host that renders it. `false` on the server. */
export function useAuthDialogOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}
