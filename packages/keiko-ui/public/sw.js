// Keiko service worker — minimal install-enabling shim.
//
// This file is plain JavaScript on purpose: browsers load service workers raw at /sw.js with
// no bundler or TypeScript transform in the request path. Keeping the source plain JS keeps
// what runs in the browser byte-identical to what ships in the package surface, which the
// security audit (ADR-0024 D6 / D9 #126) depends on.
//
// Why this exists: Chrome only fires `beforeinstallprompt` (the gate for the #124 install
// banner) when a service worker with a `fetch` handler is registered. Without this file the
// install banner has no real install path. Therefore the SW is the smallest possible thing
// that satisfies that condition without weakening the existing security posture.
//
// Cache policy — REQUIRED INVARIANTS (ADR-0024 D6, D7, D9 #126):
//   * Only static shell assets are cached (HTML, JS bundles, CSS, icons, manifest, favicons).
//   * `/api/*` is NEVER intercepted — the fetch handler returns early before any
//     `event.respondWith(...)` so the browser performs the request normally and the page
//     receives any network failure directly.
//   * No evidence manifest, workflow event, model output, or credential-derived value can
//     enter the cache. Only same-origin GET requests whose URL is in the static allow-list
//     and whose response is a `basic` 200 are cached.
//   * No `skipWaiting()` and no `clients.claim()` — a newly installed SW waits until all
//     existing clients are gone before activating, preventing a stale shell from running
//     against a new API contract.
//   * The HTML app shell (a top-level navigation, or the `/` document) is served
//     NETWORK-FIRST with a cache fallback; content-hashed static assets (`/_next/static/...`,
//     icons, manifest) stay CACHE-FIRST. Rationale: the `/` document has a STABLE url but its
//     body changes every deploy (it references a fresh content-hashed chunk graph). Cache-first
//     on `/` pins an old shell that points at chunk filenames the rebuilt server no longer
//     serves → `ChunkLoadError` / a blank "client-side exception" until a hard refresh. A
//     content-hashed asset, by contrast, gets a NEW filename on every build, so cache-first can
//     never serve it stale (a new build is always a cache miss → fresh fetch). Network-first on
//     the shell therefore picks up a redeploy immediately while preserving offline support
//     (the last-seen shell is still served when the network is unreachable). This `sw.js` is
//     byte-identical across Next builds, so the browser never re-installs the SW on a normal
//     deploy — which is exactly why the shell must self-heal at fetch time rather than relying
//     on a cache-version bump.

/* global self, caches, fetch */

// Bumped v1 -> v2 with the network-first shell policy below: when this SW finally activates it
// deletes the stale v1 cache (which may hold an old `/` document) in the `activate` handler.
const CACHE_NAME = "keiko-shell-v2";

// Static shell pre-cache. These are pathnames that must be available offline for the app
// shell to boot. Everything else (e.g. `/_next/static/...` chunks) is cached on first
// successful fetch via the runtime cache-first strategy below — pre-caching the full chunk
// graph would couple this file to the Next build output, which is fragile.
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-192-maskable.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon.png",
];

// Pathname prefixes that may be served from / written to the runtime cache. Anything that
// does not match one of these prefixes falls through to the network without ever touching
// CacheStorage. This list intentionally does NOT include `/api/` — see `isApiRequest`.
const CACHEABLE_PREFIXES = [
  "/_next/static/",
  "/icon-",
  "/apple-touch-icon",
  "/favicon",
  "/manifest.webmanifest",
];

function isApiRequest(url) {
  // url.pathname is provided by the URL parser, so it is already normalised (no `..`,
  // no fragment). Checking with a literal prefix on the parsed pathname is the only safe
  // way to identify API requests — header / referrer sniffing can be spoofed by callers.
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

function isCacheableRequest(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (isApiRequest(url)) return false;
  if (url.pathname === "/") return true;
  for (const prefix of CACHEABLE_PREFIXES) {
    if (url.pathname.startsWith(prefix)) return true;
  }
  return false;
}

function isCacheableResponse(response) {
  // `basic` = same-origin, fully readable. `opaque` (no-cors cross-origin) responses MUST
  // NOT be cached: their bodies are unreadable so they cannot be inspected and could mask
  // a leaked URL via their size on disk. The same-origin check above also already excludes
  // them, but defence-in-depth.
  return response.ok && response.status === 200 && response.type === "basic";
}

function isHtmlShellRequest(request, url) {
  // A top-level navigation (request.mode === "navigate") or the `/` document IS the HTML app
  // shell. Its url is stable but its body changes every deploy (it references the new
  // content-hashed chunk graph), so it must be revalidated against the network — see the
  // network-first rationale in the header. `request.mode` is absent in some non-browser hosts
  // (and the sandbox test harness), so fall back to the `/` pathname check.
  return request.mode === "navigate" || url.pathname === "/";
}

async function putIfCacheable(request, response) {
  if (!isCacheableResponse(response)) return;
  // Clone before .put — the response body can only be consumed once, and the caller still
  // returns the original to the page.
  const copy = response.clone();
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, copy);
}

async function cacheFirst(request) {
  // Content-hashed assets are immutable per url, so a cache hit is always correct and a new
  // build is always a cache miss → fresh fetch. Fastest path with zero staleness risk.
  if (typeof caches === "undefined") return fetch(request);
  const cached = await caches.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  await putIfCacheable(request, response);
  return response;
}

async function networkFirst(request) {
  // The HTML shell: prefer the freshest document so a redeploy's new chunk references are used
  // immediately. Refresh the cached copy on every success, and fall back to it (offline support)
  // only when the network is unreachable. A failed network with no cached fallback rethrows so
  // the page sees the real error rather than a masked one.
  if (typeof caches === "undefined") return fetch(request);
  try {
    const response = await fetch(request);
    await putIfCacheable(request, response);
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached !== undefined) return cached;
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (typeof caches === "undefined") return;
      const cache = await caches.open(CACHE_NAME);
      // Use `addAll` — if any single URL 404s the whole install fails, which is what we
      // want: a half-populated cache would silently degrade the offline experience.
      await cache.addAll(PRECACHE_URLS);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (typeof caches === "undefined") return;
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (name === CACHE_NAME ? Promise.resolve(false) : caches.delete(name))),
      );
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Parse once. `URL` throws on malformed input — let it propagate; the browser will fall
  // back to the default fetch path, which is the correct degradation.
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // /api/* early return — MUST come before any `event.respondWith(...)` so the browser
  // handles the request normally and any network failure surfaces directly to the page.
  // This is the critical invariant enforced by sw-cache-policy.test.ts.
  if (isApiRequest(url)) return;

  // Non-GET, cross-origin, or not-on-the-allow-list — let the browser handle it. We never
  // cache, never serve, never proxy.
  if (!isCacheableRequest(request, url)) return;

  // HTML shell → network-first (pick up redeploys immediately, fall back to cache offline);
  // content-hashed static assets → cache-first (fast, never stale per immutable url).
  event.respondWith(isHtmlShellRequest(request, url) ? networkFirst(request) : cacheFirst(request));
});
