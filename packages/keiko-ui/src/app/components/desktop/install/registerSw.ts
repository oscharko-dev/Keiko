"use client";

/**
 * Service worker registration helper (issue #126, ADR-0024 D6).
 *
 * Registers `/sw.js` at scope `"/"` so Chrome's `beforeinstallprompt` event can fire,
 * completing the #124 install banner's install path. Designed to be invoked from a
 * `useEffect(() => { registerSw(); }, [])` once per client mount — calling it from outside
 * the browser (SSR, prerender) is a no-op.
 *
 * Failure mode is intentionally silent: a service worker is a progressive-enhancement layer.
 * If registration fails (CSP rejected the worker, browser does not support SW, user
 * disabled SW in settings), the page continues to function normally and the install banner
 * falls back to the manual instructions shipped in #124.
 */

function hasServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

function deleteKeikoShellCaches(): void {
  if (typeof caches === "undefined") return;
  void caches
    .keys()
    .then((names) =>
      Promise.all(
        names.filter((name) => name.startsWith("keiko-shell-")).map((name) => caches.delete(name)),
      ),
    )
    .catch((_error: unknown) => undefined);
}

function cleanupDevServiceWorkers(sw: ServiceWorkerContainer): void {
  try {
    void sw
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      )
      .then(() => {
        deleteKeikoShellCaches();
        if (sw.controller === null) return;
        const reloadKey = "keiko.dev.service-worker-cleanup-reloaded";
        if (window.sessionStorage.getItem(reloadKey) === "true") return;
        window.sessionStorage.setItem(reloadKey, "true");
        window.location.reload();
      })
      .catch((_error: unknown) => undefined);
  } catch {
    // Silent failure by design. Development cleanup must never break the app.
  }
}

export function registerSw(): void {
  if (!hasServiceWorker()) return;

  // Capture a stable reference to avoid the lint warning about `navigator` access after the
  // guard (TS narrowing on a global property access).
  const sw = navigator.serviceWorker;

  if (process.env.NODE_ENV === "development") {
    cleanupDevServiceWorkers(sw);
    return;
  }

  // Fire-and-forget. Wrap the synchronous call too: although the spec says `register()`
  // returns a Promise, a non-conforming runtime (or a test stub) could throw synchronously,
  // and the helper's whole contract is that it never breaks the page. `.catch` swallows the
  // Promise rejection. Using `unknown` for the rejection value — `register()` rejects with
  // `DOMException` in spec but other runtimes may differ, and we never inspect the error
  // in production code.
  try {
    void sw.register("/sw.js", { scope: "/" }).catch((_error: unknown) => {
      // Silent failure by design. See ADR-0024 D6.
      return undefined;
    });
  } catch {
    // Silent failure by design. See ADR-0024 D6.
  }
}
