"use client";

/**
 * Hook: defers and stores the browser's `beforeinstallprompt` event.
 * Listens for `appinstalled` to clear the deferred prompt and persist
 * installed state in localStorage.
 *
 * The `BeforeInstallPromptEvent` is not in lib.dom.d.ts; we define a local
 * minimal type and use a narrowing type guard — no `any`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal local type for the non-standard BeforeInstallPromptEvent.
// https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent
type BeforeInstallPromptEvent = Event & {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
};

function isBeforeInstallPromptEvent(e: Event): e is BeforeInstallPromptEvent {
  return (
    typeof (e as BeforeInstallPromptEvent).prompt === "function" &&
    typeof (e as BeforeInstallPromptEvent).userChoice === "object"
  );
}

export interface UseInstallPromptResult {
  /** True when a deferred beforeinstallprompt is waiting and has not been resolved. */
  readonly available: boolean;
  /** Invoke to trigger the native browser install prompt. Resolves when the user responds. */
  readonly triggerInstall: () => Promise<void>;
}

export function useInstallPrompt(): UseInstallPromptResult {
  const [available, setAvailable] = useState(false);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event): void => {
      // Prevent the automatic browser mini-infobar from appearing.
      e.preventDefault();
      if (!isBeforeInstallPromptEvent(e)) return;
      promptRef.current = e;
      setAvailable(true);
    };

    const onAppInstalled = (): void => {
      localStorage.setItem("keiko.pwa.installed", "true");
      promptRef.current = null;
      setAvailable(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt, { passive: false });
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const triggerInstall = useCallback(async (): Promise<void> => {
    const prompt = promptRef.current;
    if (prompt === null) return;

    await prompt.prompt();
    const { outcome } = await prompt.userChoice;

    if (outcome === "accepted") {
      localStorage.setItem("keiko.pwa.installed", "true");
    }

    // Clear the stored prompt whether accepted or dismissed — it can only be used once.
    promptRef.current = null;
    setAvailable(false);
  }, []);

  return { available, triggerInstall };
}
