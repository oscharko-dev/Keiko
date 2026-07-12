import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(repoRoot, "packages", "keiko-ui");
const requireFromRepo = createRequire(join(repoRoot, "package.json"));
const requireFromUi = createRequire(join(uiDir, "package.json"));

const host = "127.0.0.1";
const publicBrowserHost = "localhost";
const publicPort = Number(process.env.KEIKO_DEV_UI_PORT ?? process.env.KEIKO_UI_PORT ?? "1983");
const bffPort = Number(process.env.KEIKO_DEV_BFF_PORT ?? "1984");
const nextPort = Number(process.env.KEIKO_DEV_NEXT_PORT ?? "3000");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = resolve(process.env.KEIKO_DEV_PID_FILE ?? join(stateDir, "dev-ui.pid.json"));
const bffScript = join(repoRoot, "scripts", "dev-bff.mjs");
const tscBin = requireFromRepo.resolve("typescript/bin/tsc");
const nextBin = requireFromUi.resolve("next/dist/bin/next");
const children = new Map();
const restartCounts = new Map();
const maxRestarts = Number(process.env.KEIKO_DEV_MAX_RESTARTS ?? "3");
const nextBundlerPreference = process.env.KEIKO_DEV_NEXT_BUNDLER ?? "webpack";
const skipPackageWatchForTest =
  process.env.NODE_ENV === "test" && process.env.KEIKO_DEV_TEST_SKIP_PACKAGE_WATCH === "1";
let nextBundler = nextBundlerPreference === "turbopack" ? "turbopack" : "webpack";
let server;
let shuttingDown = false;
let publicReady = false;
let readinessCheckRunning = false;
const requiredReadyProbeSuccesses = 2;

const devServiceWorker = `
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("keiko-shell-"))
          .map((name) => caches.delete(name)),
      );
    }
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    await Promise.all(windows.map((client) => client.navigate(client.url)));
  })());
});
`.trimStart();

export function publicBrowserUrl(port) {
  return `http://${publicBrowserHost}:${String(port)}`;
}

function headerValue(req, name) {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function isDocumentPath(pathname) {
  if (pathname === "/" || pathname === "") return true;
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  if (pathname.startsWith("/assets/")) return false;
  if (pathname.startsWith("/fonts/")) return false;
  return !pathname.split("/").pop()?.includes(".");
}

function acceptsDocument(req) {
  const destination = headerValue(req, "sec-fetch-dest")?.toLowerCase();
  if (destination === "document") return true;
  const accept = headerValue(req, "accept")?.toLowerCase();
  return accept === undefined || accept.includes("text/html") || accept.includes("*/*");
}

export function canonicalLocalhostRedirectLocation(req, port) {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return undefined;
  const requestHost = headerValue(req, "host")?.toLowerCase();
  if (requestHost !== `${host}:${String(port)}`) return undefined;
  const url = new URL(req.url ?? "/", `http://${host}:${String(port)}`);
  if (!isDocumentPath(url.pathname) || !acceptsDocument(req)) return undefined;
  const target = new URL(publicBrowserUrl(port));
  target.pathname = url.pathname;
  target.search = url.search;
  return target.toString();
}

function redirectToCanonicalLocalhost(req, res) {
  const location = canonicalLocalhostRedirectLocation(req, publicPort);
  if (location === undefined) return false;
  res.writeHead(307, {
    "cache-control": "no-store",
    location,
  });
  res.end();
  return true;
}

if (!["auto", "turbopack", "webpack"].includes(nextBundlerPreference)) {
  console.error(
    `Invalid KEIKO_DEV_NEXT_BUNDLER: ${nextBundlerPreference}. Use auto, turbopack, or webpack.`,
  );
  process.exit(2);
}

if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
  console.error(`Invalid KEIKO_DEV_MAX_RESTARTS: ${String(process.env.KEIKO_DEV_MAX_RESTARTS)}`);
  process.exit(2);
}

/**
 * Checks whether the given TCP port is free by attempting a connection.
 * Resolves to `true` when the port is free, `false` when something is already listening.
 * Exported for testing.
 */
export function checkNextPortFree(checkHost, checkPort, timeoutMs = 500) {
  return new Promise((resolvePortFree) => {
    const socket = connect({ host: checkHost, port: checkPort });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePortFree(true);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePortFree(false);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolvePortFree(true);
    });
  });
}

/**
 * Reads the Next.js dev-server lock file written by the bundler.
 * The file lives at `<uiDir>/.next/lock` and contains `{pid, port, appUrl}`.
 * Resolves to the parsed object, or `undefined` if absent or unreadable.
 * Exported for testing.
 */
export async function readNextLockInfo(lockPath) {
  try {
    const content = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(content);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed["pid"] === "number" &&
      typeof parsed["port"] === "number"
    ) {
      return /** @type {{ pid: number; port: number; appUrl: string }} */ (parsed);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeState(extra = {}) {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(
    pidFile,
    `${JSON.stringify(
      {
        runnerPid: process.pid,
        publicPort,
        bffPort,
        nextPort,
        stateDir,
        nextBundler,
        appUrl: publicBrowserUrl(publicPort),
        children: Array.from(children.values())
          .map((child) => child.pid)
          .filter((pid) => pid !== undefined),
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function restartChild(label) {
  const count = (restartCounts.get(label) ?? 0) + 1;
  restartCounts.set(label, count);
  if (count > maxRestarts) {
    console.error(`[dev] ${label} exceeded restart limit (${String(maxRestarts)}).`);
    shutdown(1);
    return;
  }
  const delayMs = Math.min(5_000, 500 * count);
  console.error(
    `[dev] restarting ${label} in ${String(delayMs)}ms (${String(count)}/${String(maxRestarts)}) ...`,
  );
  setTimeout(() => {
    if (shuttingDown) return;
    if (label === "bff") startBff();
    else if (label === "packages") startPackageBuildWatch();
    else startNext();
    void waitForPublicReadiness();
  }, delayMs).unref();
}

function spawnChild(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options.env,
    },
  });
  children.set(label, child);
  writeState();
  child.on("exit", (code, signal) => {
    if (children.get(label) !== child) return;
    children.delete(label);
    publicReady = false;
    writeState({ ready: false, lastExit: { label, code, signal } });
    if (shuttingDown) return;
    console.error(`[dev] ${label} exited unexpectedly.`);
    if (label === "next" && nextBundler === "turbopack" && nextBundlerPreference === "auto") {
      nextBundler = "webpack";
      restartCounts.set(label, 0);
      console.error("[dev] Turbopack dev server exited; falling back to webpack dev server.");
    }
    restartChild(label);
  });
  child.on("error", (error) => {
    console.error(`[dev] ${label} failed: ${error.message}`);
    if (!shuttingDown) restartChild(label);
  });
  return child;
}

async function fetchOk(url, validate = () => true) {
  const response = await globalThis.fetch(url, { cache: "no-store" });
  if (!response.ok) return `HTTP ${String(response.status)}`;
  return (await validate(response)) ? "ok" : "unexpected response";
}

async function readinessProbe() {
  try {
    const api = await fetchOk(`http://${host}:${String(bffPort)}/api/health`, async (response) => {
      const body = await response.json();
      return body?.status === "ok";
    });
    if (api !== "ok") return `api: ${api}`;

    const ui = await fetchOk(`http://${host}:${String(nextPort)}/`, async (response) => {
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      return contentType.includes("text/html") && body.includes("Keiko");
    });
    if (ui !== "ok") return `ui: ${ui}`;

    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function waitForPublicReadiness() {
  if (readinessCheckRunning) return;
  readinessCheckRunning = true;
  publicReady = false;
  writeState({ ready: false });
  try {
    let lastError = "not started";
    let consecutiveReadyProbes = 0;
    while (!shuttingDown) {
      lastError = await readinessProbe();
      if (lastError === "ok") {
        consecutiveReadyProbes += 1;
        if (consecutiveReadyProbes >= requiredReadyProbeSuccesses) {
          publicReady = true;
          writeState({ ready: true });
          console.log(`[dev] ready on ${publicBrowserUrl(publicPort)}`);
          return;
        }
        writeState({ ready: false, starting: "stabilizing UI" });
      } else {
        consecutiveReadyProbes = 0;
        writeState({ ready: false, starting: lastError });
      }
      await sleep(500);
    }
  } finally {
    readinessCheckRunning = false;
  }
}

function startBff() {
  spawnChild("bff", process.execPath, ["--watch", "--watch-preserve-output", bffScript], {
    cwd: repoRoot,
    env: {
      KEIKO_DEV_BFF_PORT: String(bffPort),
      KEIKO_STATE_DIR: stateDir,
    },
  });
}

function packageBuildWatchArgs() {
  return [tscBin, "-b", "tsconfig.packages.json", "--watch", "--preserveWatchOutput"];
}

function startPackageBuildWatch() {
  spawnChild("packages", process.execPath, packageBuildWatchArgs(), {
    cwd: repoRoot,
    env: {},
  });
}

function nextArgs() {
  return [
    nextBin,
    "dev",
    "--hostname",
    host,
    "--port",
    String(nextPort),
    nextBundler === "webpack" ? "--webpack" : "--turbopack",
  ];
}

function startNext() {
  spawnChild("next", process.execPath, nextArgs(), {
    cwd: uiDir,
    env: {
      PORT: String(nextPort),
    },
  });
}

function rewriteOriginHeader(value, targetPort) {
  try {
    const origin = new URL(value);
    const publicAuthorities = new Set([
      `${host}:${String(publicPort)}`,
      `localhost:${String(publicPort)}`,
      `[::1]:${String(publicPort)}`,
    ]);
    if (!publicAuthorities.has(origin.host.toLowerCase())) {
      return value;
    }
    return `${origin.protocol}//${host}:${String(targetPort)}`;
  } catch {
    return value;
  }
}

const UNSAFE_HEADER_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function copyHeadersSafely(source) {
  const safe = Object.create(null);
  if (source === null || typeof source !== "object") return safe;
  for (const name of Object.keys(source)) {
    if (UNSAFE_HEADER_NAMES.has(name.toLowerCase())) continue;
    if (!Object.hasOwn(source, name)) continue;
    safe[name] = source[name];
  }
  return safe;
}

function proxiedHeaders(req, targetPort) {
  const headers = copyHeadersSafely(req.headers);
  headers.host = `${host}:${String(targetPort)}`;
  if (typeof headers.origin === "string") {
    headers.origin = rewriteOriginHeader(headers.origin, targetPort);
  }
  return headers;
}

function normalizeUpstreamLocation(rawLocation, targetPort) {
  if (typeof rawLocation !== "string") return undefined;
  const upstreamBase = `http://${host}:${String(targetPort)}`;
  try {
    const resolved = new URL(rawLocation, upstreamBase);
    if (resolved.hostname !== host || resolved.port !== String(targetPort)) {
      return undefined;
    }
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function forwardedUpstreamHeaders(upstreamHeaders, targetPort) {
  const safe = copyHeadersSafely(upstreamHeaders);
  if ("location" in safe) {
    const normalized = normalizeUpstreamLocation(safe.location, targetPort);
    if (normalized === undefined) {
      delete safe.location;
    } else {
      safe.location = normalized;
    }
  }
  return safe;
}

function proxyHttp(req, res, targetPort) {
  const headers = proxiedHeaders(req, targetPort);
  const upstream = request(
    {
      hostname: host,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(
        upstreamRes.statusCode ?? 502,
        forwardedUpstreamHeaders(upstreamRes.headers, targetPort),
      );
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Development upstream is not available.");
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, targetPort) {
  const headers = proxiedHeaders(req, targetPort);
  const upstream = connect(targetPort, host, () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) upstream.write(`${name}: ${item}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const destroyTunnel = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", destroyTunnel);
  socket.on("error", destroyTunnel);
}

function targetPortFor(pathname) {
  return pathname.startsWith("/api/") || pathname === "/api" ? bffPort : nextPort;
}

function serveDevServiceWorker(res) {
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/javascript; charset=utf-8",
  });
  res.end(devServiceWorker);
}

function serveStarting(res) {
  res.writeHead(503, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "retry-after": "1",
  });
  res.end("Keiko development server is starting.");
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  writeState({ ready: false, shuttingDown: true });
  server?.close(() => undefined);
  for (const child of children.values()) {
    if (child.pid !== undefined) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children.values()) {
      if (child.pid !== undefined) child.kill("SIGKILL");
    }
    process.exit(code);
  }, 5_000).unref();
  if (children.size === 0) process.exit(code);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith("dev-runner.mjs");

if (invokedDirectly) {
  // PREFLIGHT: fail fast if next dev is already running on the configured port.
  const nextLockPath = join(uiDir, ".next", "lock");
  const [portFree, publicPortFree, lockInfo] = await Promise.all([
    checkNextPortFree(host, nextPort),
    // The public port had NO bind-time check: dev-start's probe runs before the
    // (long) build, so two concurrent `dev:start`s could both pass it and the
    // loser only failed ~60s later with an opaque health timeout. Checking here,
    // immediately before listen(), turns that into a fast explicit error.
    checkNextPortFree(host, publicPort),
    readNextLockInfo(nextLockPath),
  ]);
  if (!publicPortFree) {
    console.error(`[dev] PREFLIGHT FAILED: public port ${String(publicPort)} is already in use.`);
    console.error(
      "[dev] Another dev runner (or the packaged Keiko UI) is already listening on it.",
    );
    console.error(
      `[dev] Stop it with: npm run dev:stop — or: lsof -ti tcp:${String(publicPort)} | xargs kill`,
    );
    process.exit(1);
  }
  if (!portFree) {
    const pidHint =
      lockInfo !== undefined ? ` (PID ${String(lockInfo.pid)}, ${lockInfo.appUrl})` : "";
    const stopHint =
      lockInfo !== undefined
        ? `kill ${String(lockInfo.pid)}`
        : `lsof -ti tcp:${String(nextPort)} | xargs kill`;
    console.error(`[dev] PREFLIGHT FAILED: port ${String(nextPort)} is already in use${pidHint}.`);
    console.error(`[dev] A next dev server is already running for this project.`);
    console.error(`[dev] To stop it, run: ${stopHint}`);
    console.error(
      `[dev] Or start on a different port: KEIKO_DEV_NEXT_PORT=3001 node scripts/dev-runner.mjs`,
    );
    process.exit(1);
  }

  // The readiness integration test exercises BFF/Next warmup and runs beside the package suite.
  // Its test-only seam prevents a real tsc --watch from mutating the shared dist graph mid-suite.
  if (!skipPackageWatchForTest) startPackageBuildWatch();
  startBff();
  startNext();

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${String(publicPort)}`);
    if (redirectToCanonicalLocalhost(req, res)) {
      return;
    }
    if (url.pathname === "/sw.js") {
      serveDevServiceWorker(res);
      return;
    }
    if (!publicReady) {
      serveStarting(res);
      return;
    }
    proxyHttp(req, res, targetPortFor(url.pathname));
  });

  server.on("upgrade", (req, socket, head) => {
    if (!publicReady) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\n" +
          "Connection: close\r\n" +
          "Retry-After: 1\r\n" +
          "\r\n",
      );
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}:${String(publicPort)}`);
    proxyUpgrade(req, socket, head, targetPortFor(url.pathname));
  });

  // The preflight closes the common race, but a competitor can still take the
  // port between check and bind — surface that as a clear one-liner instead of
  // an uncaught EADDRINUSE stack.
  server.once("error", (error) => {
    if (error !== null && typeof error === "object" && error.code === "EADDRINUSE") {
      console.error(
        `[dev] public port ${String(publicPort)} was taken between preflight and bind; ` +
          "run `npm run dev:stop` (or free the port) and retry.",
      );
      shutdown(1);
      return;
    }
    throw error;
  });
  server.listen(publicPort, host, () => {
    writeState({ ready: false, starting: "waiting for API and UI" });
    console.log(`[dev] listening on ${publicBrowserUrl(publicPort)} (warming up)`);
    void waitForPublicReadiness();
  });

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
}
