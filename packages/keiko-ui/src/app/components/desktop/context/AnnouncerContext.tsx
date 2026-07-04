"use client";

// GEN-UI-A11Y-004 — app-level status live-region channel.
//
// One always-mounted pair of visually-hidden live regions (role="status" aria-live="polite" and
// role="alert" aria-live="assertive") lives at the shell so any surface can post an outcome string
// that screen readers announce, even when the originating surface is deep in the window tree or has
// already unmounted. The regions are rendered OUTSIDE the window-render path (see AppShell) so they
// never unmount and never drop an announcement.
//
// The channel is deliberately minimal: it provides the regions + a `announce(message, opts?)` hook.
// Routing every existing async completion through it is out of scope — this only opens the channel.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface AnnounceOptions {
  // Route to the assertive (role="alert") region for time-critical outcomes (errors, failures).
  // Defaults to the polite (role="status") region.
  readonly assertive?: boolean;
}

export interface AnnouncerApi {
  readonly announce: (message: string, opts?: AnnounceOptions) => void;
}

const AnnouncerContext = createContext<AnnouncerApi | null>(null);

interface AnnouncerProviderProps {
  readonly children: ReactNode;
}

// Re-posting the same string does not re-fire a live region (identical text content is not a DOM
// change AT reacts to). A monotonically-incrementing nonce, rendered as a trailing invisible marker,
// forces a distinct text mutation so a repeated outcome is still announced.
export function AnnouncerProvider({ children }: AnnouncerProviderProps): ReactNode {
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const nonceRef = useRef(0);

  const announce = useCallback((message: string, opts?: AnnounceOptions): void => {
    nonceRef.current += 1;
    const withNonce = nonceRef.current % 2 === 0 ? message : `${message}​`;
    if (opts?.assertive === true) {
      setAssertiveMessage(withNonce);
    } else {
      setPoliteMessage(withNonce);
    }
  }, []);

  const api = useMemo<AnnouncerApi>(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={api}>
      {children}
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="app-announcer-polite"
      >
        {politeMessage}
      </div>
      <div
        className="visually-hidden"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="app-announcer-assertive"
      >
        {assertiveMessage}
      </div>
    </AnnouncerContext.Provider>
  );
}

// Required hook: any surface under the provider can post an outcome string.
export function useAnnouncer(): AnnouncerApi {
  const ctx = useContext(AnnouncerContext);
  if (ctx === null) {
    throw new Error("useAnnouncer must be used inside AnnouncerProvider");
  }
  return ctx;
}

// Optional read for surfaces (and tests) that may render outside the provider. Returns a no-op
// channel so callers never need to guard the provider's presence.
const NOOP_ANNOUNCER: AnnouncerApi = { announce: () => undefined };

export function useOptionalAnnouncer(): AnnouncerApi {
  return useContext(AnnouncerContext) ?? NOOP_ANNOUNCER;
}
