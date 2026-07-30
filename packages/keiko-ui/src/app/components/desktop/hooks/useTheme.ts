"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "keiko.theme";
const DEFAULT_THEME: Theme = "dark";
const THEME_CHANGE_EVENT = "keiko:theme-change";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export interface UseThemeResult {
  theme: Theme;
  toggle: () => void;
}

export function useTheme(): UseThemeResult {
  // Start from the static default so the build-time prerender (no localStorage)
  // and the client's first render agree. Reading localStorage in the initializer
  // would diverge and trip React #418 (hydration mismatch) on the rail sun/moon
  // icon. The stored theme is adopted right after mount.
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setTheme(readStoredTheme());
    setHydrated(true);
  }, []);

  useEffect(() => {
    const handleThemeChange = (event: Event): void => {
      const nextTheme = (event as CustomEvent<Theme>).detail;
      if (nextTheme === "light" || nextTheme === "dark") setTheme(nextTheme);
    };
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    return (): void => window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage may be unavailable; theme is still applied in-memory. */
    }
    window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
  }, [theme, hydrated]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }, []);

  return { theme, toggle };
}
