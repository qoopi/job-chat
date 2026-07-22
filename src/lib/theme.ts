"use client";

import { useCallback, useState } from "react";

// The account menu's Dark-mode toggle. It persists via the EXISTING `theme` cookie
// mechanism - layout.tsx reads that cookie server-side and stamps `<html data-theme>` before paint
// (no FOUC), so the choice survives a reload for guests AND signed-in users. Per-account server-side
// theme storage is deferred: the cookie is the store. The toggle also flips the `<html data-theme>`
// attribute immediately so the whole app re-themes in place, without waiting for a navigation.

export type Theme = "Light" | "Dark";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year (matches the guest cookie)

/** The theme currently stamped on `<html>` (server-rendered from the cookie). "Light" on the server. */
export function currentTheme(): Theme {
  if (typeof document === "undefined") return "Light";
  return document.documentElement.getAttribute("data-theme") === "Dark"
    ? "Dark"
    : "Light";
}

/** Persist + apply a theme: write the `theme` cookie the server reads next render, and flip the
 *  `<html data-theme>` attribute now so the whole app re-themes without a reload. */
export function applyTheme(theme: Theme): void {
  const value = theme === "Dark" ? "dark" : "light";
  document.cookie = `theme=${value}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
  document.documentElement.setAttribute("data-theme", theme);
}

/** `[theme, toggle]` for the Dark-mode switch. Lazily seeded from the SSR-stamped attribute (the toggle
 *  only ever renders after the menu is opened, well past hydration), then toggles + persists in place. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "Dark" ? "Light" : "Dark";
      applyTheme(next);
      return next;
    });
  }, []);
  return [theme, toggle];
}
