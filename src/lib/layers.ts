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

// refresh #2 ruling 4: the account menu is a transient that sits ABOVE the LCP but BELOW the auth dialog
// (Esc order: dialog > menu > LCP). Same boolean-seam shape as the dialog flag - no layer framework. The
// AccountMenu flips this on its open/close; the LCP's Esc handler yields while it is true so a single Esc
// closes the menu first and leaves the LCP for a second Esc.
let menuOpen = false;

/** The account menu calls this when it opens/closes so Esc closes the menu before the LCP beneath it. */
export function setMenuOpen(open: boolean): void {
  menuOpen = open;
}

/** True while the account menu is open and should consume Esc before the LCP (but after the dialog). */
export function isMenuOpen(): boolean {
  return menuOpen;
}
