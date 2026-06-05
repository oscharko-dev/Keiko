"use client";

/**
 * InstallBanner — non-intrusive PWA install affordance.
 *
 * Visibility rules (all must be true):
 *  1. keiko.pwa.installed absent in localStorage
 *  2. keiko.pwa.dismissed absent in localStorage
 *  3. window.matchMedia("(display-mode: standalone)").matches === false
 *  4. Either a deferred beforeinstallprompt is available (Chromium) OR
 *     browserSupport returns "ios-add-to-home" (iOS Safari fallback).
 *
 * Content boundary (ADR-0024 D7.4): all copy is static literals — no
 * workspace paths, model names, run IDs, credentials, or user data.
 *
 * Accessibility: <aside role="region" aria-label="Install Keiko">
 * WCAG 2.2 AA — contrast, keyboard, focus-visible, 24×24 target, reduced-motion.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { detectSupport } from "./browserSupport";
import { useInstallPrompt } from "./useInstallPrompt";

// ---------------------------------------------------------------------------
// Constants (static copy — D7.4 content boundary enforced)
// ---------------------------------------------------------------------------

const COPY = {
  supported: {
    heading: "Install Keiko",
    body: "Keep Keiko in your app shelf for fast access.",
    install: "Install Keiko",
  },
  "ios-add-to-home": {
    heading: "Install Keiko",
    body: 'On iOS Safari, tap Share, then "Add to Home Screen".',
    install: null, // no install button — instructions only
  },
} as const;

const NOT_NOW_LABEL = "Not now";
const CLOSE_LABEL = "Dismiss install banner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

function isAlreadyInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("keiko.pwa.installed") === "true";
}

function isAlreadyDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("keiko.pwa.dismissed") !== null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InstallBanner(): ReactNode {
  const { available, triggerInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(false);
  const [support] = useState(() =>
    typeof navigator !== "undefined" ? detectSupport(navigator.userAgent) : "manual",
  );
  const installButtonRef = useRef<HTMLButtonElement>(null);

  // Dismiss handler — writes to localStorage, sets local dismissed state.
  const dismiss = useCallback((): void => {
    localStorage.setItem("keiko.pwa.dismissed", new Date().toISOString());
    setDismissed(true);
  }, []);

  // Install handler.
  const handleInstall = useCallback(async (): Promise<void> => {
    await triggerInstall();
  }, [triggerInstall]);

  // Keyboard handler: Escape closes the banner.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        dismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  // ---------------------------------------------------------------------------
  // Visibility gate
  // ---------------------------------------------------------------------------

  if (dismissed) return null;
  if (isStandalone()) return null;
  if (isAlreadyInstalled()) return null;
  if (isAlreadyDismissed()) return null;

  // Show Chromium banner when beforeinstallprompt has been captured.
  if (support === "supported" && !available) return null;

  // Show iOS banner for ios-add-to-home support level.
  // Show nothing for "manual" — manual fallback is out-of-scope for this child.
  if (support !== "supported" && support !== "ios-add-to-home") return null;

  const copy = COPY[support];

  return (
    <aside className="install-banner" role="region" aria-label="Install Keiko">
      <div className="install-banner-body">
        <div className="install-banner-text">
          <span className="install-banner-heading">{copy.heading}</span>
          <span className="install-banner-desc">{copy.body}</span>
        </div>
        <div className="install-banner-actions">
          {copy.install !== null && (
            <button
              ref={installButtonRef}
              type="button"
              className="install-banner-btn-install"
              onClick={() => void handleInstall()}
            >
              {copy.install}
            </button>
          )}
          <button
            type="button"
            className="install-banner-btn-dismiss"
            aria-label={CLOSE_LABEL}
            onClick={dismiss}
          >
            <span aria-hidden="true">{NOT_NOW_LABEL}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
