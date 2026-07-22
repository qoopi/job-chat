"use client";

import { useEffect, useSyncExternalStore } from "react";
import { setAuthDialogOpen } from "@/lib/layers";

// Single source of truth for the lazy auth dialog's open state - a module singleton ("only one dialog at a
// time"). Opening flips setAuthDialogOpen (layers.ts) so the LCP yields Esc to the dialog first (dialog > LCP).

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function openAuthDialog(): void {
  if (open) return;
  open = true;
  setAuthDialogOpen(true);
  emit();
}

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

export function useAuthDialogOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}

/** Open the dialog on mount when the URL carries an OAuth `?error=` (the Google callback bounced back). Client-only, runs once. */
export function useOpenAuthDialogOnError(): void {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error")) openAuthDialog();
  }, []);
}
