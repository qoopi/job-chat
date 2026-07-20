// The layer-priority seam (interaction-spec "Priority of layers": auth dialog > LCP > thread; Esc
// closes the topmost layer only). This is the STUB seam for AC-9's Esc rule: until 013 ships the auth
// dialog, the LCP is always topmost, so Esc closes it. When 013's dialog opens it flips this flag so a
// single keydown listener routes Esc to the dialog first and leaves the LCP open. A boolean check by
// design - not a layer framework (one dialog, one LCP, one toast at a time).
let authDialogOpen = false;

/** 013 calls this when its auth dialog opens/closes so Esc routes to the topmost layer. */
export function setAuthDialogOpen(open: boolean): void {
  authDialogOpen = open;
}

/** True while a layer above the LCP (the auth dialog) is open and should consume Esc first. */
export function isAuthDialogOpen(): boolean {
  return authDialogOpen;
}
