"use client";

/**
 * Static-shell service worker registration helper.
 *
 * Registers `/sw.js` at scope `"/"` for static shell cache/update recovery. Designed to be invoked from a
 * `useEffect(() => { registerSw(); }, [])` once per client mount — calling it from outside
 * the browser (SSR, prerender) is a no-op.
 *
 * Failure mode is intentionally silent: a service worker is a progressive-enhancement layer.
 * If registration fails (CSP rejected the worker, browser does not support SW, user disabled
 * SW in settings), the page continues to function normally.
 */

const ACTIVATE_WAITING_MESSAGE_TYPE = "KEIKO_ACTIVATE_WAITING_SERVICE_WORKER";
const UPDATE_RELOAD_PENDING_KEY = "keiko.service-worker-update-reload-pending";

let reloadedForActivatedUpdate = false;

function hasServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

function setPendingUpdateReload(): void {
  try {
    window.sessionStorage.setItem(UPDATE_RELOAD_PENDING_KEY, "true");
  } catch {
    // Session storage can be blocked. Keep update activation as a best-effort recovery path.
  }
}

function consumePendingUpdateReload(): boolean {
  try {
    if (window.sessionStorage.getItem(UPDATE_RELOAD_PENDING_KEY) !== "true") return false;
    window.sessionStorage.removeItem(UPDATE_RELOAD_PENDING_KEY);
    return true;
  } catch {
    return true;
  }
}

function clearPendingUpdateReload(): void {
  try {
    window.sessionStorage.removeItem(UPDATE_RELOAD_PENDING_KEY);
  } catch {
    // Session storage can be blocked. There is nothing to clear in that case.
  }
}

function reloadOnceForActivatedUpdate(): void {
  if (reloadedForActivatedUpdate) return;
  if (!consumePendingUpdateReload()) return;
  reloadedForActivatedUpdate = true;
  window.location.reload();
}

function installControllerChangeReload(sw: ServiceWorkerContainer): void {
  sw.addEventListener("controllerchange", reloadOnceForActivatedUpdate);
}

function activateWaitingWorker(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting;
  if (waiting === null) return;

  setPendingUpdateReload();
  try {
    waiting.postMessage({ type: ACTIVATE_WAITING_MESSAGE_TYPE });
  } catch {
    clearPendingUpdateReload();
  }
}

function watchInstallingWorker(
  sw: ServiceWorkerContainer,
  registration: ServiceWorkerRegistration,
): void {
  const installing = registration.installing;
  if (installing === null) return;

  installing.addEventListener("statechange", () => {
    if (installing.state !== "installed") return;
    if (sw.controller === null) return;
    activateWaitingWorker(registration);
  });
}

function handleRegisteredServiceWorker(
  sw: ServiceWorkerContainer,
  registration: ServiceWorkerRegistration,
): void {
  installControllerChangeReload(sw);

  if (sw.controller !== null) {
    activateWaitingWorker(registration);
  }

  registration.addEventListener("updatefound", () => {
    watchInstallingWorker(sw, registration);
  });
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
  // Silent failure by design: development cleanup must never break the app, so both failure modes
  // are swallowed. Invoking inside `.then` rather than a `try` is what makes that possible with a
  // single handler: a synchronous throw from the call itself, which a non-conforming runtime (or a
  // test stub) could still raise even though the spec says `getRegistrations()` returns a Promise,
  // is converted into a rejection and lands in the same `.catch`. A `try` around a promise-returning
  // call is rejected by typescript:S4822 in either direction.
  void Promise.resolve()
    .then(() => sw.getRegistrations())
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

  // Fire-and-forget, silent failure by design: static shell caching must never break app startup,
  // so both failure modes are swallowed. Invoking inside `.then` rather than a `try` is what makes
  // that possible with a single handler: a synchronous throw from the call itself, which a
  // non-conforming runtime (or a test stub) could still raise even though the spec says `register()`
  // returns a Promise, is converted into a rejection and lands in the same `.catch`. A `try` around
  // a promise-returning call is rejected by typescript:S4822 in either direction. Using `unknown`
  // for the rejection value — `register()` rejects with `DOMException` in spec but other runtimes
  // may differ, and we never inspect the error in production code.
  void Promise.resolve()
    .then(() => sw.register("/sw.js", { scope: "/" }))
    .then((registration) => {
      handleRegisteredServiceWorker(sw, registration);
    })
    .catch((_error: unknown) => undefined);
}
