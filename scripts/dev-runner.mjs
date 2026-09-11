import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(repoRoot, "packages", "keiko-ui");
const requireFromUi = createRequire(join(uiDir, "package.json"));
const tscBin = join(repoRoot, "node_modules", "@typescript", "native", "bin", "tsc");

const host = "127.0.0.1";
const publicBrowserHost = "localhost";
const publicPort = Number(process.env.KEIKO_DEV_UI_PORT ?? process.env.KEIKO_UI_PORT ?? "1983");
const bffPort = Number(process.env.KEIKO_DEV_BFF_PORT ?? "1984");
let nextPort = Number(process.env.KEIKO_DEV_NEXT_PORT ?? "3000");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = resolve(process.env.KEIKO_DEV_PID_FILE ?? join(stateDir, "dev-ui.pid.json"));
const bffScript = join(repoRoot, "scripts", "dev-bff.mjs");
const nextBin = requireFromUi.resolve("next/dist/bin/next");
const nextLockPath = join(uiDir, ".next", "lock");
const children = new Map();
const maxRestarts = Number(process.env.KEIKO_DEV_MAX_RESTARTS ?? "3");
const restartDelayMs = Number(process.env.KEIKO_DEV_RESTART_DELAY_MS ?? "500");
const restartStabilityMs = Number(process.env.KEIKO_DEV_RESTART_STABILITY_MS ?? "300000");
const nextBundlerPreference = process.env.KEIKO_DEV_NEXT_BUNDLER ?? "auto";
const skipPackageWatchForTest =
  process.env.NODE_ENV === "test" && process.env.KEIKO_DEV_TEST_SKIP_PACKAGE_WATCH === "1";
export const DEV_RUNNER_SHUTDOWN_GRACE_MS = 35_000;
export function resolveNextBundler(preference) {
  if (preference === "auto" || preference === "turbopack") return "turbopack";
  if (preference === "webpack") return "webpack";
  throw new TypeError(
    `Invalid KEIKO_DEV_NEXT_BUNDLER: ${preference}. Use auto, turbopack, or webpack.`,
  );
}

export function resolveConfiguredNextBundler(preference) {
  try {
    return resolveNextBundler(preference);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid KEIKO_DEV_NEXT_BUNDLER.");
    process.exit(2);
  }
}

let nextBundler = resolveConfiguredNextBundler(nextBundlerPreference);
let server;
let bffCodeWatch;
let shuttingDown = false;
let publicReady = false;
let readinessCheckRunning = false;
export function createMicrophoneAllowanceController(initialAllowance = false) {
  let allowance = initialAllowance === true;
  let revision = 0;
  return {
    current: () => allowance,
    revision: () => revision,
    revoke: () => {
      revision += 1;
      allowance = false;
      return revision;
    },
    observe: (observedRevision, nextAllowance) => {
      if (observedRevision !== revision) return false;
      allowance = nextAllowance === true;
      return true;
    },
  };
}

const microphoneAllowance = createMicrophoneAllowanceController();
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

if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
  console.error(`Invalid KEIKO_DEV_MAX_RESTARTS: ${String(process.env.KEIKO_DEV_MAX_RESTARTS)}`);
  process.exit(2);
}

if (!Number.isSafeInteger(restartDelayMs) || restartDelayMs < 0 || restartDelayMs > 60_000) {
  console.error(
    `Invalid KEIKO_DEV_RESTART_DELAY_MS: ${String(process.env.KEIKO_DEV_RESTART_DELAY_MS)}`,
  );
  process.exit(2);
}

if (
  !Number.isSafeInteger(restartStabilityMs) ||
  restartStabilityMs < 1_000 ||
  restartStabilityMs > 3_600_000
) {
  console.error(
    `Invalid KEIKO_DEV_RESTART_STABILITY_MS: ${String(process.env.KEIKO_DEV_RESTART_STABILITY_MS)}`,
  );
  process.exit(2);
}

export function createRestartBudget(maximumRestarts, stabilityMs, schedule = setTimeout) {
  const counts = new Map();
  const stabilityTimers = new Map();

  const cancelStabilityTimer = (label) => {
    const timer = stabilityTimers.get(label);
    if (timer !== undefined) clearTimeout(timer);
    stabilityTimers.delete(label);
  };

  return {
    recordExit(label) {
      cancelStabilityTimer(label);
      const count = (counts.get(label) ?? 0) + 1;
      counts.set(label, count);
      return { count, allowed: count <= maximumRestarts };
    },
    recordStableRestart(label) {
      if (!counts.has(label)) return;
      cancelStabilityTimer(label);
      const timer = schedule(() => {
        counts.delete(label);
        stabilityTimers.delete(label);
      }, stabilityMs);
      timer.unref?.();
      stabilityTimers.set(label, timer);
    },
  };
}

// F71: the runner's children, the ones it stops on purpose, and what an exit means. A child stopped
// on purpose (the BFF after its code changed) respawns at once and is not a crash; any other exit
// of a running child is one, counted against the restart budget, and the runner decides from that
// verdict whether to respawn after a delay or give up.
export function createChildSupervisor(hooks) {
  const state = { hooks, children: hooks.children ?? new Map(), intendedRestarts: new Set() };
  return {
    children: state.children,
    spawn(label, command, args, options) {
      const child = (hooks.spawnProcess ?? spawn)(command, args, {
        ...options,
        stdio: "inherit",
        env: { ...process.env, ...options.env },
      });
      state.children.set(label, child);
      hooks.restartBudget.recordStableRestart(label);
      hooks.onSpawn?.(label, child);
      superviseChild(state, label, child);
      return child;
    },
    // Stops a running child on purpose, once for a burst of requests. A child that is not running,
    // or is already stopping, is left alone: its next start loads the new code anyway.
    restartOnPurpose(label) {
      const child = state.children.get(label);
      if (hooks.isShuttingDown() || child === undefined || state.intendedRestarts.has(label)) {
        return false;
      }
      state.intendedRestarts.add(label);
      child.kill("SIGTERM");
      return true;
    },
  };
}

function superviseChild({ hooks, children, intendedRestarts }, label, child) {
  const crashed = () => {
    hooks.onCrash(label, hooks.restartBudget.recordExit(label));
  };
  child.on("exit", (code, signal) => {
    if (children.get(label) !== child) return;
    children.delete(label);
    hooks.onExit?.(label, code, signal);
    if (hooks.isShuttingDown()) return;
    if (intendedRestarts.delete(label)) {
      hooks.respawn(label);
      return;
    }
    hooks.onUnexpectedExit?.(label);
    crashed();
  });
  child.on("error", (error) => {
    hooks.onError?.(label, error);
    if (!hooks.isShuttingDown()) crashed();
  });
}

const restartBudget = createRestartBudget(maxRestarts, restartStabilityMs);
const supervisor = createChildSupervisor({
  children,
  restartBudget,
  isShuttingDown: () => shuttingDown,
  onSpawn: () => {
    writeState();
  },
  onExit: (label, code, signal) => {
    publicReady = false;
    if (label === "bff") microphoneAllowance.revoke();
    writeState({ ready: false, lastExit: { label, code, signal } });
  },
  onUnexpectedExit: (label) => {
    console.error(`[dev] ${label} exited unexpectedly.`);
    if (label === "next" && nextBundler === "turbopack" && nextBundlerPreference === "auto") {
      nextBundler = "webpack";
      console.error("[dev] Turbopack dev server exited; falling back to webpack dev server.");
    }
  },
  onError: (label, error) => {
    console.error(`[dev] ${label} failed: ${error.message}`);
  },
  respawn: restartChildAfterDelay,
  onCrash: restartChild,
});

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
      isValidProcessId(parsed["pid"]) &&
      isValidTcpPort(parsed["port"])
    ) {
      return /** @type {{ pid: number; port: number; appUrl: string }} */ (parsed);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isValidProcessId(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function isValidTcpPort(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function processIsAlive(pid) {
  if (!isValidProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function findAvailableNextPort(startPort, checkPortFree = checkNextPortFree) {
  if (!isValidTcpPort(startPort)) {
    throw new TypeError(`Invalid Next.js port: ${String(startPort)}`);
  }
  const finalPort = Math.min(65_535, startPort + 99);
  for (let port = startPort; port <= finalPort; port += 1) {
    if (await checkPortFree(host, port)) return port;
  }
  throw new Error(`No free Next.js port found at or above ${String(startPort)}`);
}

function resolveNextRespawnIo(overrides = {}) {
  return {
    checkPortFree: overrides.checkPortFree ?? checkNextPortFree,
    lockExists: overrides.lockExists ?? pathExists,
    processIsAlive: overrides.processIsAlive ?? processIsAlive,
    readLock: overrides.readLock ?? readNextLockInfo,
    removeLock: overrides.removeLock ?? ((path) => rm(path, { force: true })),
  };
}

function isSameLockOwner(left, right) {
  return left?.pid === right?.pid && left?.port === right?.port;
}

async function releaseStaleNextLock(lockPath, lockInfo, currentPort, io) {
  if (lockInfo === undefined) {
    throw new Error("Next.js lock ownership could not be validated");
  }
  if (io.processIsAlive(lockInfo.pid) && lockInfo.port !== currentPort) {
    return;
  }
  if (io.processIsAlive(lockInfo.pid)) {
    throw new Error(`Next.js lock is held by live process ${String(lockInfo.pid)}`);
  }
  const currentLockInfo = await io.readLock(lockPath);
  if (!isSameLockOwner(lockInfo, currentLockInfo)) {
    throw new Error("Next.js lock changed before stale-lock removal");
  }
  await io.removeLock(lockPath);
}

export async function preflightNextRespawn(currentPort, lockPath, overrides = {}) {
  if (!isValidTcpPort(currentPort)) {
    throw new TypeError(`Invalid Next.js port: ${String(currentPort)}`);
  }
  const io = resolveNextRespawnIo(overrides);
  const [portFree, lockPresent, lockInfo] = await Promise.all([
    io.checkPortFree(host, currentPort),
    io.lockExists(lockPath),
    io.readLock(lockPath),
  ]);
  if (lockPresent) await releaseStaleNextLock(lockPath, lockInfo, currentPort, io);
  const selectedPort = portFree
    ? currentPort
    : await findAvailableNextPort(currentPort + 1, io.checkPortFree);
  return { nextPort: selectedPort, reselected: selectedPort !== currentPort };
}

const defaultAtomicFileOperations = { renameSync, rmSync, writeFileSync };

function removeIncompleteAtomicWrite(operations, temporaryPath) {
  try {
    operations.rmSync(temporaryPath, { force: true });
  } catch {
    console.error("[dev] failed to remove an incomplete state-file replacement.");
  }
}

export function writeAtomicUtf8File(path, contents, operations = defaultAtomicFileOperations) {
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  try {
    operations.writeFileSync(temporaryPath, contents, "utf8");
    operations.renameSync(temporaryPath, path);
  } catch (error) {
    removeIncompleteAtomicWrite(operations, temporaryPath);
    throw error;
  }
}

export function writeState(extra = {}, stateFile = pidFile) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeAtomicUtf8File(
    stateFile,
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
  );
}

// A crash the supervisor counted arrives with its verdict; the Next preflight's own retry is counted
// here.
function restartChild(label, { allowed, count } = restartBudget.recordExit(label)) {
  if (!allowed) {
    console.error(
      `[dev] ${label} exceeded restart limit (${String(maxRestarts)}) within the ` +
        `${String(restartStabilityMs)}ms stability window.`,
    );
    shutdown(1);
    return;
  }
  const delayMs = Math.min(60_000, restartDelayMs * count);
  console.error(
    `[dev] restarting ${label} in ${String(delayMs)}ms ` +
      `(${String(count)}/${String(maxRestarts)} before stability reset) ...`,
  );
  setTimeout(() => {
    restartChildAfterDelay(label);
  }, delayMs).unref();
}

function restartChildAfterDelay(label) {
  if (shuttingDown) return;
  if (label === "bff") startBff();
  else if (label === "packages") startPackageBuildWatch();
  else {
    void restartNextChild();
    return;
  }
  void waitForPublicReadiness();
}

export async function restartNextChildWithRetry({
  currentPort,
  lockPath,
  preflight = preflightNextRespawn,
  isShuttingDown,
  selectPort,
  start,
  waitForReadiness,
  retry,
  reportError,
}) {
  try {
    const result = await preflight(currentPort, lockPath);
    if (isShuttingDown()) return { retried: false, started: false };
    if (result.reselected) {
      selectPort(result.nextPort);
    }
    start();
    waitForReadiness().catch(reportError);
    return { retried: false, started: true };
  } catch (error) {
    reportError(error);
    retry();
    return { retried: true, started: false };
  }
}

async function restartNextChild() {
  await restartNextChildWithRetry({
    currentPort: nextPort,
    lockPath: nextLockPath,
    isShuttingDown: () => shuttingDown,
    selectPort: (selectedPort) => {
      nextPort = selectedPort;
      console.error(`[dev] Next.js port was busy; respawning on ${String(nextPort)}.`);
    },
    start: startNext,
    waitForReadiness: waitForPublicReadiness,
    retry: () => restartChild("next"),
    reportError: (error) => {
      console.error(`[dev] Next.js respawn preflight failed: ${String(error)}`);
    },
  });
}

async function fetchOk(url, validate = async () => true) {
  const response = await globalThis.fetch(url, { cache: "no-store" });
  if (!response.ok) return `HTTP ${String(response.status)}`;
  return (await validate(response)) ? "ok" : "unexpected response";
}

export function microphoneAllowanceAfterChildExit(label, currentAllowance) {
  return label === "bff" ? false : currentAllowance === true;
}

export async function probeApiReadiness(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) {
      return { result: `HTTP ${String(response.status)}`, allowSameOriginMicrophone: false };
    }
    const body = await response.json();
    const healthy = body?.status === "ok";
    return {
      result: healthy ? "ok" : "unexpected response",
      allowSameOriginMicrophone:
        healthy &&
        upstreamAllowsSameOriginMicrophone(Object.fromEntries(response.headers.entries())),
    };
  } catch (error) {
    return {
      result: error instanceof Error ? error.message : String(error),
      allowSameOriginMicrophone: false,
    };
  }
}

async function readinessProbe() {
  const observedRevision = microphoneAllowance.revision();
  try {
    const api = await probeApiReadiness(`http://${host}:${String(bffPort)}/api/health`);
    microphoneAllowance.observe(observedRevision, api.allowSameOriginMicrophone);
    if (api.result !== "ok") return `api: ${api.result}`;

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
  supervisor.spawn("bff", process.execPath, bffProcessArgs(bffScript), {
    cwd: repoRoot,
    env: bffChildEnv(bffPort, publicPort, stateDir),
  });
}

function startBffCodeWatch() {
  const roots = bffCodeRoots(repoRoot);
  const tracker = createContentDigestTracker();
  tracker.seed(bffCodeFiles(roots));
  bffCodeWatch = createBffCodeWatch({ roots, tracker, onChange: restartBffForCodeChange });
}

// One controlled restart for a burst of code changes: the BFF is stopped on purpose and respawned
// as soon as it exited. A BFF that is not running, or already restarting, is left alone: its next
// start loads the new code anyway.
function restartBffForCodeChange(changed) {
  if (!supervisor.restartOnPurpose("bff")) return;
  console.error(
    `[dev] bff code changed (${String(changed.length)} file(s)); restarting the bff ...`,
  );
}

// The packaged CLI exports the public loopback port to the server; the dev lane mirrors it so
// coding-runtime activation can compose gateway and editor-agent loopback URLs (#2475).
export function bffChildEnv(bffListenPort, publicUiPort, keikoStateDir) {
  return {
    KEIKO_CODING_RUNTIME_DEV_LANE: "1",
    KEIKO_DEV_BFF_PORT: String(bffListenPort),
    KEIKO_UI_PORT: String(publicUiPort),
    KEIKO_STATE_DIR: keikoStateDir,
  };
}

// F71: `node --watch` restarted the BFF on every write to a file it had loaded, a content-identical
// one included (a touched source whose rebuild emits the same JavaScript), and a restart ends a
// live run. The BFF runs as a plain process; the runner watches its code and restarts it only when
// a file's content changed.
export function bffProcessArgs(scriptPath) {
  return [scriptPath];
}

// Hermetic tests keep one stable BFF process: a rebuild mid-suite must not restart it.
export function bffCodeWatchEnabled(env) {
  return !(env.NODE_ENV === "test" && env.KEIKO_DEV_TEST_SKIP_BFF_WATCH === "1");
}

const BFF_CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json"]);

export function isBffCodePath(path) {
  return BFF_CODE_EXTENSIONS.has(extname(path));
}

function fileDigest(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // A file that is gone, or cannot be read, has no content: its absence is the change.
    return undefined;
  }
}

/**
 * The last content seen for each watched file. `changed(paths)` names the paths whose bytes differ
 * from it, a new or removed file included, and records the new content; a path that was only
 * touched is never named.
 */
export function createContentDigestTracker(readDigest = fileDigest) {
  const digests = new Map();
  return {
    seed(paths) {
      for (const path of paths) digests.set(path, readDigest(path));
    },
    changed(paths) {
      const changed = [];
      for (const path of new Set(paths)) {
        const next = readDigest(path);
        if (digests.get(path) === next) continue;
        digests.set(path, next);
        changed.push(path);
      }
      return changed;
    },
  };
}

// A recursive watcher names a file relative to its root. Only a non-empty name that resolves inside
// that root can be a file the BFF loads; anything else is dropped before it reaches the tracker
// (PR #3452 review).
function watchedFile(root, name) {
  if (!root.recursive) return root.path;
  const text = name === null || name === undefined ? "" : String(name);
  if (text.length === 0 || text.includes("\0")) return undefined;
  const file = join(root.path, text);
  const inside = relative(root.path, file);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) return undefined;
  return isAbsolute(inside) ? undefined : file;
}

// A directory's inode, or undefined when it is absent: tells a directory that appeared or was
// replaced from one that was only written into.
function directoryIdentity(path) {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
}

function codeFilesUnder(path) {
  try {
    return readdirSync(path, { recursive: true })
      .map((name) => join(path, String(name)))
      .filter(isBffCodePath);
  } catch {
    // An absent directory holds no code yet.
    return [];
  }
}

/**
 * Watches the BFF's code (a directory recursively, or one file) and calls `onChange` with the paths
 * whose content changed, once per burst: a rebuild writes many files at once.
 */
export function createBffCodeWatch({
  roots,
  tracker,
  onChange,
  debounceMs = 300,
  watchImpl = watch,
  schedule = setTimeout,
  cancel = clearTimeout,
  identify = directoryIdentity,
  listCode = codeFilesUnder,
}) {
  const pending = new Set();
  let timer;
  const flush = () => {
    timer = undefined;
    const changed = tracker.changed([...pending]);
    pending.clear();
    if (changed.length > 0) onChange(changed);
  };
  const note = (files) => {
    if (files.length === 0) return;
    for (const file of files) pending.add(file);
    if (timer !== undefined) cancel(timer);
    timer = schedule(flush, debounceMs);
  };
  const watchers = roots.flatMap((root) =>
    watchCodeRoot(root, { watchImpl, identify, listCode, note }),
  );
  return {
    close() {
      for (const watcher of watchers) watcher.close();
      if (timer !== undefined) cancel(timer);
    },
  };
}

// A package's output directory can appear after the watch started (a runner started before the
// first build) or be replaced while it runs (a clean rebuild). Its parent reports either, and the
// watch on the directory itself is re-armed then, with the code in it counted as changed.
function watchCodeRoot(root, { watchImpl, identify, listCode, note }) {
  const listener = (_event, name) => {
    const file = watchedFile(root, name);
    if (file !== undefined && isBffCodePath(file)) note([file]);
  };
  if (!root.recursive) {
    return [watchImpl(root.path, { recursive: false, persistent: false }, listener)];
  }
  const arm = (identity) =>
    identity === undefined
      ? undefined
      : watchImpl(root.path, { recursive: true, persistent: false }, listener);
  let identity = identify(root.path);
  let inner = arm(identity);
  const parent = watchImpl(
    dirname(root.path),
    { recursive: false, persistent: false },
    (_event, name) => {
      if (name === null || String(name) !== basename(root.path)) return;
      const next = identify(root.path);
      if (next === identity) return;
      identity = next;
      inner?.close();
      inner = arm(next);
      note(listCode(root.path));
    },
  );
  return [parent, { close: () => inner?.close() }];
}

// What the BFF loads from this checkout: every package's build output, whether or not it exists yet,
// and the BFF's own two scripts.
function bffCodeRoots(root) {
  const packages = join(root, "packages");
  const dists = readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packages, entry.name, "dist"));
  return [
    ...dists.map((path) => ({ path, recursive: true })),
    { path: join(root, "scripts", "dev-bff.mjs"), recursive: false },
    { path: join(root, "scripts", "lib", "dev-bff-shutdown.mjs"), recursive: false },
  ];
}

function bffCodeFiles(roots) {
  return roots.flatMap((root) => (root.recursive ? codeFilesUnder(root.path) : [root.path]));
}

export function packageBuildWatchArgs() {
  return [tscBin, "-b", "tsconfig.packages.json", "--watch", "--preserveWatchOutput"];
}

function startPackageBuildWatch() {
  supervisor.spawn("packages", process.execPath, packageBuildWatchArgs(), {
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
  supervisor.spawn("next", process.execPath, nextArgs(), {
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

export function copyHeadersSafely(source) {
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

export function normalizeUpstreamLocation(
  rawLocation,
  targetPort,
  publicRedirectPort = publicPort,
) {
  if (typeof rawLocation !== "string") return undefined;
  const upstreamBase = `http://${host}:${String(targetPort)}`;
  try {
    const resolved = new URL(rawLocation, upstreamBase);
    if (resolved.hostname !== host || resolved.port !== String(targetPort)) {
      return undefined;
    }
    // Same-origin redirects from the internal upstream must be rewritten back onto the public
    // proxy origin so the browser keeps talking to the proxy (which then routes /api/* to the
    // BFF and everything else to Next), rather than dialing the internal port directly.
    const publicUrl = new URL(publicBrowserUrl(publicRedirectPort));
    publicUrl.pathname = resolved.pathname;
    publicUrl.search = resolved.search;
    publicUrl.hash = resolved.hash;
    return publicUrl.toString();
  } catch {
    return undefined;
  }
}

// KEIKO-0607: the documented default dev workflow (`npm run dev:start`) served the entire app
// shell (every response the dev-runner routed to the Next.js dev process) with zero CSP or
// security headers — only the BFF-routed /api/* traffic was hardened by packages/keiko-server/
// src/headers.ts. That left the dev-lane completely open to reflected-XSS, clickjacking, and
// mixed-origin content, and it silently drifted farther from production every time a Studio
// page was edited without live coverage. Mirror the production baseline on every proxied
// response — including the Next.js-routed ones. The CSP is deliberately relaxed for the two
// directives Next.js Fast Refresh/HMR requires; every other production header stays as-is.
//
// The relaxations are scoped to the specific directives HMR needs, NOT the whole policy:
//   `script-src 'self' 'unsafe-eval' 'unsafe-inline'` — Fast Refresh injects HMR runtime
//     modules and inline error overlays.
//   `style-src 'self' 'unsafe-inline'` — Fast Refresh writes style tags for CSS module updates.
//   `connect-src 'self' ws: wss:` — the HMR web socket used to signal a rebuild.
//   `img-src 'self' data: blob:` — Studio and Fast Refresh both source images from data: URIs.
// Every other production directive (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`,
// `base-uri 'self'`, `form-action 'self'`) is kept unchanged.
const DEV_SECURITY_HEADERS = Object.freeze({
  "content-security-policy":
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

function devPermissionsPolicy(allowMicrophone) {
  const microphone = allowMicrophone ? "microphone=(self)" : "microphone=()";
  return `camera=(), geolocation=(), ${microphone}, payment=(), usb=()`;
}

export function upstreamAllowsSameOriginMicrophone(upstreamHeaders) {
  const value = upstreamHeaders?.["permissions-policy"];
  return (
    typeof value === "string" &&
    value.split(",").some((directive) => directive.trim() === "microphone=(self)")
  );
}

function bffRequestMutatesMicrophoneAllowance(method) {
  const normalized = typeof method === "string" ? method.toUpperCase() : "";
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

async function refreshMicrophoneAllowance(controller, expectedRevision, policyBffPort) {
  const api = await probeApiReadiness(`http://${host}:${String(policyBffPort)}/api/health`);
  controller.observe(expectedRevision, api.allowSameOriginMicrophone);
}

export function forwardedUpstreamHeaders(upstreamHeaders, targetPort, options = {}) {
  const safe = copyHeadersSafely(upstreamHeaders);
  if ("location" in safe) {
    const normalized = normalizeUpstreamLocation(safe.location, targetPort);
    if (normalized === undefined) {
      delete safe.location;
    } else {
      safe.location = normalized;
    }
  }
  // KEIKO-0607: apply the dev security header baseline to every proxied response, overriding
  // any upstream-supplied variant (the BFF may set its own; the dev-runner is the last edge
  // that touches the byte stream on its way back to the browser, so it owns the final say).
  for (const [name, value] of Object.entries(DEV_SECURITY_HEADERS)) {
    safe[name] = value;
  }
  // The BFF owns the capability decision. The dev edge mirrors that decision onto Next.js HTML
  // responses so a voice-capable development deployment can request same-origin microphone access.
  // Omission and every non-boolean value remain fail-closed; the policy is never widened to `*`.
  safe["permissions-policy"] = devPermissionsPolicy(options.allowMicrophone === true);
  return safe;
}

function createProxyLifecycle(req, res, onSettled = () => undefined) {
  let upstream;
  let upstreamResponse;
  let settled = false;
  const detach = () => {
    req.off("aborted", abort);
    res.off("close", downstreamClosed);
  };
  const settle = () => {
    if (settled) return false;
    settled = true;
    detach();
    onSettled();
    return true;
  };
  const abort = () => {
    if (!settle()) return;
    upstreamResponse?.destroy();
    upstream?.destroy();
  };
  const downstreamClosed = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", downstreamClosed);
  return {
    bindRequest: (value) => {
      upstream = value;
    },
    bindResponse: (value) => {
      upstreamResponse = value;
      value.once("end", settle);
      value.once("aborted", abort);
    },
    settle,
  };
}

function forwardProxyResponse({ upstreamRes, res, lifecycle, policy, targetPort }) {
  lifecycle.bindResponse(upstreamRes);
  res.writeHead(
    upstreamRes.statusCode ?? 502,
    forwardedUpstreamHeaders(upstreamRes.headers, targetPort, {
      allowMicrophone: policy.current(),
    }),
  );
  upstreamRes.pipe(res);
}

// Node's global agent pools keep-alive sockets, and a pooled socket that the upstream closes at the
// instant it is reused fails the request with ECONNRESET before a byte reaches the server. The
// handler below can only answer that with 502, which is how a `/_next/static/chunks/*.js` fetch came
// back 502 twice on CI while a sibling chunk requested in the same millisecond returned 200. This
// proxy fronts a loopback development server and has no use for pooled connections, so give it an
// agent that never reuses one: the race disappears by construction instead of being retried around.
const proxyAgent = new Agent({ keepAlive: false });

// Discarding this error is how a proxied 502 became unattributable: the browser saw a failed chunk
// fetch and the runner said nothing, so the cause had to be reconstructed from a Playwright trace.
// Name the request and the reason instead. Repository tooling keeps deterministic stderr output
// rather than the product activity log (AGENTS.md §8).
// A proxied target carries its query string, and Keiko's own development traffic puts secrets there
// — an `/api/editor/agent/events?…&bridgeDecisionCapability=…` request goes through this very proxy.
// Report the route and how many parameters it carried, never their values: counts, not content, is
// the rule for every evidence surface in this repository (AGENTS.md §7).
function redactQuery(path) {
  const target = String(path);
  const separator = target.indexOf("?");
  if (separator < 0) return target;
  const query = target.slice(separator + 1);
  const count = query === "" ? 0 : query.split("&").length;
  return `${target.slice(0, separator)}?<${String(count)} redacted>`;
}

export function upstreamFailureDiagnostic(method, path, targetPort, error) {
  return (
    `dev-runner: upstream ${String(method)} ${redactQuery(path)} to :${String(targetPort)} failed ` +
    `(${String(error.code ?? error.message)})\n`
  );
}

function answerUpstreamFailure({ error, req, res, path, targetPort, lifecycle }) {
  if (!lifecycle.settle()) return;
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  }
  process.stderr.write(upstreamFailureDiagnostic(req.method, path, targetPort, error));
  res.end("Development upstream is not available.");
}

export function proxyHttp(
  req,
  res,
  targetPort,
  policyBffPort = bffPort,
  policy = microphoneAllowance,
) {
  const path = req.url;
  if (typeof path !== "string" || !/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@/%?-]*$/u.test(path)) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Invalid development proxy request path.");
    return;
  }
  const forwardsToBff = targetPort === policyBffPort;
  const mutationRevision =
    forwardsToBff && bffRequestMutatesMicrophoneAllowance(req.method) ? policy.revoke() : undefined;
  const headers = proxiedHeaders(req, targetPort);
  const lifecycle = createProxyLifecycle(req, res, () => {
    if (mutationRevision !== undefined) {
      void refreshMicrophoneAllowance(policy, mutationRevision, policyBffPort);
    }
  });
  const upstream = request(
    {
      agent: proxyAgent,
      hostname: host,
      port: targetPort,
      path,
      method: req.method,
      headers,
    },
    (upstreamRes) =>
      forwardProxyResponse({
        upstreamRes,
        res,
        lifecycle,
        policy,
        targetPort,
      }),
  );
  lifecycle.bindRequest(upstream);
  upstream.on("error", (error) =>
    answerUpstreamFailure({ error, req, res, path, targetPort, lifecycle }),
  );
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
  bffCodeWatch?.close();
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
  }, DEV_RUNNER_SHUTDOWN_GRACE_MS).unref();
  if (children.size === 0) process.exit(code);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith("dev-runner.mjs");

if (invokedDirectly) {
  // PREFLIGHT: fail fast if next dev is already running on the configured port.
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
  if (bffCodeWatchEnabled(process.env)) startBffCodeWatch();
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
    if (typeof error === "object" && error.code === "EADDRINUSE") {
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
