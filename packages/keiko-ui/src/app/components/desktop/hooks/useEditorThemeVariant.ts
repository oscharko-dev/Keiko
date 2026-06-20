"use client";

import { useEffect, useState } from "react";

import type { EditorThemeVariant } from "@oscharko-dev/keiko-editor";

/**
 * Track the active app appearance as a Keiko Editor theme variant, live (Issue #1196 follow-up).
 *
 * The app's light/dark choice is published on `<html data-theme>` by {@link
 * import("./useTheme.js").useTheme} (the single source of truth the CSS cascade reacts to). Because
 * that hook holds per-instance state rather than a shared context, this hook reads the DOM attribute
 * directly and observes it, so the editor follows a theme toggle made anywhere in the app. The
 * high-contrast variant is opted into from `prefers-contrast`/`forced-colors`.
 *
 * SSR-safe: the static export prerenders this client component, where there is no DOM, so it starts
 * from the same `"dark"` default `useTheme` uses (keeping the prerender and first client render in
 * agreement) and adopts the real value after mount.
 */
export function useEditorThemeVariant(): EditorThemeVariant {
  const [variant, setVariant] = useState<EditorThemeVariant>("dark");

  useEffect(() => {
    const update = (): void => {
      setVariant(readEditorThemeVariant());
    };
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const contrast = window.matchMedia("(prefers-contrast: more)");
    const forced = window.matchMedia("(forced-colors: active)");
    contrast.addEventListener("change", update);
    forced.addEventListener("change", update);

    return () => {
      observer.disconnect();
      contrast.removeEventListener("change", update);
      forced.removeEventListener("change", update);
    };
  }, []);

  return variant;
}

/** Resolve the current editor theme variant from the live DOM appearance state. */
export function readEditorThemeVariant(): EditorThemeVariant {
  if (typeof document === "undefined") return "dark";
  const appTheme: "light" | "dark" =
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const prefersHighContrast =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    (window.matchMedia("(prefers-contrast: more)").matches ||
      window.matchMedia("(forced-colors: active)").matches);
  // The editor package ships a single dark high-contrast variant (hc-black base), so escalate to it
  // only in dark mode. In light mode the high-contrast `--ed-*` token step-ups already apply through
  // the live design tokens, so the light variant stays correct.
  if (prefersHighContrast && appTheme === "dark") return "high-contrast";
  return appTheme;
}
