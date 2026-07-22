// Layer-priority seam: Esc closes the topmost layer only (order: auth dialog > account menu > LCP > thread). Boolean checks, not a framework.
let authDialogOpen = false;

export function setAuthDialogOpen(open: boolean): void {
  authDialogOpen = open;
}

export function isAuthDialogOpen(): boolean {
  return authDialogOpen;
}

let menuOpen = false;

export function setMenuOpen(open: boolean): void {
  menuOpen = open;
}

export function isMenuOpen(): boolean {
  return menuOpen;
}
