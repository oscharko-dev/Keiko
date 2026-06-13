import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(repoRoot, "packages", "keiko-ui");
const requireFromUi = createRequire(join(uiDir, "package.json"));

const host = "127.0.0.1";
const publicPort = Number(process.env.KEIKO_DEV_UI_PORT ?? process.env.KEIKO_UI_PORT ?? "1983");
const bffPort = Number(process.env.KEIKO_DEV_BFF_PORT ?? "1984");
const nextPort = Number(process.env.KEIKO_DEV_NEXT_PORT ?? "3000");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = resolve(process.env.KEIKO_DEV_PID_FILE ?? join(stateDir, "dev-ui.pid.json"));
const bffScript = join(repoRoot, "scripts", "dev-bff.mjs");
const nextBin = requireFromUi.resolve("next/dist/bin/next");
const children = new Map();
const restartCounts = new Map();
const maxRestarts = Number(process.env.KEIKO_DEV_MAX_RESTARTS ?? "3");
const nextBundlerPreference = process.env.KEIKO_DEV_NEXT_BUNDLER ?? "webpack";
let nextBundler = nextBundlerPreference === "turbopack" ? "turbopack" : "webpack";
let server;
let shuttingDown = false;
let publicReady = false;
let readinessCheckRunning = false;

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
    while (!shuttingDown) {
      lastError = await readinessProbe();
      if (lastError === "ok") {
        publicReady = true;
        writeState({ ready: true });
        console.log(`[dev] ready on http://${host}:${String(publicPort)}`);
        return;
      }
      writeState({ ready: false, starting: lastError });
      await sleep(500);
    }
  } finally {
    readinessCheckRunning = false;
  }
}

function startBff() {
  spawnChild("bff", process.execPath, [bffScript], {
    cwd: repoRoot,
    env: {
      KEIKO_DEV_BFF_PORT: String(bffPort),
      KEIKO_STATE_DIR: stateDir,
    },
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

function proxiedHeaders(req, targetPort) {
  const headers = { ...req.headers, host: `${host}:${String(targetPort)}` };
  if (typeof headers.origin === "string") {
    headers.origin = rewriteOriginHeader(headers.origin, targetPort);
  }
  return headers;
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
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
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

startBff();
startNext();

server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${String(publicPort)}`);
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

server.listen(publicPort, host, () => {
  writeState({ ready: false, starting: "waiting for API and UI" });
  console.log(`[dev] listening on http://${host}:${String(publicPort)} (warming up)`);
  void waitForPublicReadiness();
});

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
