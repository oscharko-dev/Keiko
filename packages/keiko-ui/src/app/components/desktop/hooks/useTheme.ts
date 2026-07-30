"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "keiko.theme";
const DEFAULT_THEME: Theme = "dark";
const THEME_CHANGE_EVENT = "keiko:theme-change";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function readActiveTheme(): Theme {
  if (typeof document !== "undefined") {
    const activeTheme = document.documentElement.dataset.theme;
    if (isTheme(activeTheme)) return activeTheme;
  }
  return readStoredTheme();
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
  const syncingFromEventRef = useRef(false);

  useEffect((): void => {
    setTheme(readActiveTheme());
    setHydrated(true);
  }, []);

  useEffect((): (() => void) => {
    const handleThemeChange = (event: Event): void => {
      if (!(event instanceof CustomEvent) || !isTheme(event.detail)) return;
      const nextTheme = event.detail;
      setTheme((current) => {
        if (current === nextTheme) return current;
        syncingFromEventRef.current = true;
        return nextTheme;
      });
    };
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    return (): void => window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  }, []);

  useEffect((): void => {
    if (!hydrated) return;
    const shouldBroadcast = !syncingFromEventRef.current;
    syncingFromEventRef.current = false;
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage may be unavailable; theme is still applied in-memory. */
    }
    if (shouldBroadcast) {
      window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
    }
  }, [theme, hydrated]);

  const toggle = useCallback((): void => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }, []);

  return { theme, toggle };
}
