"use client";

import { useCallback, useState } from "react";

// Dark-mode toggle: persists via the theme cookie (layout.tsx stamps `<html data-theme>` server-side before
// paint, no FOUC), and flips the attribute immediately so the app re-themes in place without a reload.

export type Theme = "Light" | "Dark";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year (matches the guest cookie)

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "Light";
  return document.documentElement.getAttribute("data-theme") === "Dark"
    ? "Dark"
    : "Light";
}

export function applyTheme(theme: Theme): void {
  const value = theme === "Dark" ? "dark" : "light";
  document.cookie = `theme=${value}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
  document.documentElement.setAttribute("data-theme", theme);
}

/** `[theme, toggle]`; lazily seeded from the SSR-stamped attribute (the toggle renders only after the menu opens, past hydration). */
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
