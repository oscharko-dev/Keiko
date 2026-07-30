"use client";

/**
 * Guarded persistence for the two flags the PWA install affordance keeps in `localStorage`
 * (0.3.0 release audit).
 *
 * Neither `localStorage.getItem` nor `localStorage.setItem` is total. A browser configured to block
 * site data (Safari private browsing, a third-party context, "block all cookies") makes the
 * `localStorage` property access itself throw a `SecurityError`, and a write additionally throws
 * `QuotaExceededError` once the origin's quota is exhausted. Both call sites in this folder ran
 * unguarded: the reads sit inside `InstallBanner`'s visibility gate — i.e. during render, where a
 * throw takes the whole shell down — and the writes sit ahead of the lines in `useInstallPrompt`
 * that retire a consumed prompt, so a throw left the hook advertising an install prompt the browser
 * can never show again.
 *
 * Both flags are session conveniences, not governance records: losing one re-offers the banner on
 * the next visit, which is strictly better than a crash. So a blocked environment is reported as
 * "nothing stored" rather than raised — the caller's in-memory state is what the current session
 * actually behaves on, and it stays correct either way.
 */

/** The only two keys this feature persists. A closed union keeps the surface auditable. */
export type InstallStateKey = "keiko.pwa.installed" | "keiko.pwa.dismissed";

/** Reads a persisted install flag, treating a blocked store as "not set". Never throws. */
export function readInstallState(key: InstallStateKey): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage is unreachable (blocked site data, or no `window` during static prerender). "Absent"
    // is the honest answer and is exactly how an unset flag already behaves.
    return null;
  }
}

/** Persists an install flag, degrading to session-only state when the store rejects it. */
export function writeInstallState(key: InstallStateKey, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store or exhausted quota. There is no operator surface for this flag and nothing
    // downstream depends on it, so the write degrades to the caller's in-memory state instead of
    // escaping a render or an event handler.
  }
}
