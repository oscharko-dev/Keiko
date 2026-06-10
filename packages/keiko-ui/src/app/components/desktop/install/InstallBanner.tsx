"use client";

/**
 * InstallBanner — non-intrusive PWA install affordance.
 *
 * Visibility rules (all must be true):
 *  1. keiko.pwa.installed absent in localStorage
 *  2. keiko.pwa.dismissed absent in localStorage or older than 30 days
 *     ("Not now" promises deferral, not permanence — audit C248)
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

import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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

// Visible text doubles as the accessible name (WCAG 2.5.3 Label in Name — audit C014).
const NOT_NOW_LABEL = "Not now";

// "Not now" is a deferral, not a permanent opt-out: the dismissal expires after
// 30 days so the affordance eventually returns (audit C248).
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  const raw = localStorage.getItem("keiko.pwa.dismissed");
  if (raw === null) return false;
  // The stored value is an ISO timestamp; honour it as a TTL. Unparseable
  // legacy values stay dismissed (conservative — no surprise re-prompt).
  const dismissedAt = Date.parse(raw);
  if (Number.isNaN(dismissedAt)) return true;
  return Date.now() - dismissedAt < DISMISS_TTL_MS;
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

  // Keyboard handler: Escape closes the banner — scoped to focus INSIDE the
  // banner (React bubbling on the <aside>), never a window-wide listener.
  // A global listener permanently dismissed the banner whenever Escape was
  // pressed anywhere in the app, even while the banner was not rendered
  // (audit C037).
  const onBannerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>): void => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        dismiss();
      }
    },
    [dismiss],
  );

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
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-dismiss must be scoped to focus inside the banner (audit C037); the buttons inside are the interactive targets
    <aside
      className="install-banner"
      role="region"
      aria-label="Install Keiko"
      onKeyDown={onBannerKeyDown}
    >
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
          <button type="button" className="install-banner-btn-dismiss" onClick={dismiss}>
            {NOT_NOW_LABEL}
          </button>
        </div>
      </div>
    </aside>
  );
}
