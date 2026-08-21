// `keiko ui` — launches the local Wave 1 UI BFF (ADR-0011). It resolves the packaged static export
// (dist/ui/static) and the precomputed CSP hashes (dist/ui/csp-hashes.json) relative to this
// compiled module, builds the CSP, starts createUiServer bound to 127.0.0.1 only, prints the local
// URL, and keeps running until the process is signalled. Exit 2 on a usage error (bad --host/--port
// or a flag missing its value), 1 when the static export is not present (the package was built with
// `npm run build` but not `npm run build:ui`).
//
// ADR-0013 D2 site 1 — Detect-and-re-exec guard. Node 22.0–22.11 builds require
// --experimental-sqlite to import node:sqlite; the governed Node.js 24 LTS line loads it without
// the flag. The guard tries
// the import; on failure it re-spawns the current process with --experimental-sqlite prepended,
// inheriting stdio and forwarding SIGINT/SIGTERM to the child, then propagates the child's exit
// code. Injected-test invocations skip the guard entirely.

import type { Server } from "node:http";
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  DEFAULT_UI_PORT,
  KEIKO_PRODUCT_VERSION,
  UI_HOST,
  type UpdateInstallModeKind,
} from "@oscharko-dev/keiko-contracts";
import type { ServerLogSink, UiHandlerDeps } from "@oscharko-dev/keiko-server";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { resolvePreferredInstallLayout } from "./install-layout.js";
// GEN-PERF-CLI-001 — the server module graph (routes, local-knowledge/sqlite wiring,
// ws, …) loads on FIRST USE, not when this module is parsed. The CLI barrel evaluates
// ui.ts on every `keiko` invocation, and this one eager import accounted for most of
// the measured ~410ms per-command module-loading tax (`keiko --version` included).
// Only type imports may reference the package at module scope here.
import { loadServer as loadServerModule } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { defaultUiDataDir } from "./state-paths.js";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const KEIKO_PROCESS_TITLE = "Keiko";
const SQLITE_FLAG = "--experimental-sqlite";
// Deliberately a closed allowlist: repo-local .env discovery must not import KEIKO_*
// runtime configuration because the UI may be launched from an untrusted project root.
// FIGMA_ACCESS_TOKEN is the documented Figma connector exception (#751); it is consumed
// server-side only and never sent to the browser.
const LOCAL_DOTENV_ENV_NAME_ALLOWLIST: ReadonlySet<string> = new Set(["FIGMA_ACCESS_TOKEN"]);
const DEFAULT_STATE_DIR = ".keiko";

const USAGE = `Usage:
  keiko ui [--port PORT] [--host 127.0.0.1|localhost] [--evidence-dir PATH] [--config PATH] [--ui-db PATH]

Launches the local Keiko UI on the loopback interface and prints its URL. The server
binds 127.0.0.1 only and serves the packaged UI assets (built with \`npm run build:ui\`).
`;

export interface UiCliArgs {
  readonly port: number;
  readonly evidenceDir: string | undefined;
  readonly config: string | undefined;
  readonly uiDbPath: string | undefined;
}

type UiParseResult = UiCliArgs | "help" | null;
type UiFlag = "--port" | "--host" | "--evidence-dir" | "--config" | "--ui-db";

interface RawUiOptions {
  portRaw?: string | undefined;
  hostRaw?: string | undefined;
  evidenceRaw?: string | undefined;
  configRaw?: string | undefined;
  uiDbRaw?: string | undefined;
}

// Test seam: inject a server factory and the resolved asset paths so unit tests never bind a real
// socket or require a built dist/. Defaults resolve the packaged assets relative to this module.
export interface UiCliDeps {
  readonly createServer?: (deps: {
    staticRoot: string;
    csp: string;
    // KEIKO-0439: the live CSP source the CLI builds via `createLiveCspSource`. Forwarding the
    // ACCESSOR (not `.csp()` evaluated once at startup) lets the server survive a rebuild/restart
    // race — server.ts uses `(await deps.cspProvider?.()) ?? deps.csp` to pick the freshest header,
    // so `csp` stays as the compatibility snapshot and `cspProvider` supplies the live reads.
    cspProvider?: (() => string | Promise<string>) | undefined;
    port: number;
    handlerDeps: UiHandlerDeps;
  }) => Server | Promise<Server>;
  readonly staticRoot?: string;
  readonly hashesFile?: string;
  // ADR-0013 D2 — test seams for the re-exec guard. `sqliteProbe` returns true when node:sqlite
  // loads without the flag; spawnFn replaces child_process.spawn so we can drive the branch
  // synchronously in tests without ever forking a real process.
  readonly sqliteProbe?: () => boolean;
  readonly spawnFn?: SpawnFn;
  // Test seam: returns the current execArgv. Defaults to process.execArgv. Tests override this
  // so the vitest worker's own --experimental-sqlite does not short-circuit the guard.
  readonly currentExecArgv?: () => readonly string[];
  // Test seam for local .env discovery. Defaults to process.cwd().
  readonly cwd?: string | undefined;
  // Test seam for the process-lifecycle log lines (`process.started`/`process.exiting`/
  // `process.heartbeat`). The real path builds a file sink via `createFileServerLogSink`, which
  // the injected-server tests must not do (see `startUiServer`'s comment). Injecting a fake sink
  // here lets a test assert on the lifecycle events without loading the real server module graph
  // or writing outside its own fixture.
  readonly activityLog?: ServerLogSink | undefined;
}

interface LiveCspSource {
  readonly csp: () => string;
  readonly dispose: () => void;
}

interface CspMaterial {
  readonly hashes: readonly string[];
  readonly header: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: SpawnOptions,
) => ChildProcess;

async function collectHtmlFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectHtmlFiles(full)));
      continue;
    }
    if (entry.name.endsWith(".html")) {
      files.push(full);
    }
  }
  return files;
}

function parseHashList(raw: string): readonly string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

async function loadCspMaterial(staticRoot: string, hashesFile: string): Promise<CspMaterial> {
  const { buildCspHeader, extractInlineScriptHashes } = await loadServerModule();
  const htmlFiles = await collectHtmlFiles(staticRoot);
  const documents = await Promise.all(htmlFiles.map((file) => readFile(file, "utf8")));
  const runtimeHashes = extractInlineScriptHashes(documents);
  try {
    const raw = await readFile(hashesFile, "utf8");
    const storedHashes = parseHashList(raw);
    if (
      storedHashes.length === runtimeHashes.length &&
      storedHashes.every((hash, index) => hash === runtimeHashes[index])
    ) {
      return { hashes: storedHashes, header: buildCspHeader(storedHashes) };
    }
  } catch {
    // Fall back to the runtime export-derived hashes below.
  }
  return { hashes: runtimeHashes, header: buildCspHeader(runtimeHashes) };
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) {
    return null;
  }
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

function readFlagValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function isUiFlag(arg: string): arg is UiFlag {
  return (
    arg === "--port" ||
    arg === "--host" ||
    arg === "--evidence-dir" ||
    arg === "--config" ||
    arg === "--ui-db"
  );
}

function setRawUiOption(raw: RawUiOptions, flag: UiFlag, value: string): void {
  switch (flag) {
    case "--port":
      raw.portRaw = value;
      return;
    case "--host":
      raw.hostRaw = value;
      return;
    case "--evidence-dir":
      raw.evidenceRaw = value;
      return;
    case "--config":
      raw.configRaw = value;
      return;
    case "--ui-db":
      raw.uiDbRaw = value;
      return;
  }
}

function collectUiOptions(args: readonly string[]): RawUiOptions | "help" | null {
  const raw: RawUiOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return null;
    if (arg === "--help" || arg === "-h") return "help";
    if (!isUiFlag(arg)) return null;
    const value = readFlagValue(args, i);
    if (value === null) return null;
    setRawUiOption(raw, arg, value);
    i += 1;
  }
  return raw;
}

// Parses flags. Returns the parsed args, or null on any usage error (missing flag value, invalid
// port, or a host other than the two loopback names).
export function parseUiArgs(args: readonly string[]): UiParseResult {
  const raw = collectUiOptions(args);
  if (raw === "help" || raw === null) return raw;
  const { portRaw, hostRaw, evidenceRaw, configRaw, uiDbRaw } = raw;
  if (hostRaw !== undefined && !ALLOWED_HOSTS.has(hostRaw)) {
    return null;
  }
  const port = portRaw === undefined ? DEFAULT_UI_PORT : parsePort(portRaw);
  if (port === null) {
    return null;
  }
  return { port, evidenceDir: evidenceRaw, config: configRaw, uiDbPath: uiDbRaw };
}

function defaultStaticRoot(cwd: string): string {
  const preferredLayout = resolvePreferredInstallLayout(cwd);
  if (preferredLayout !== undefined) return preferredLayout.staticRoot;
  // The root bin shim (`dist/cli/index.js`) surfaces `KEIKO_UI_STATIC_ROOT` so the
  // cli package does not have to know its own installation layout. The
  // import.meta.url fallback preserves the standalone behaviour for callers that
  // construct UiCliDeps without going through the bin shim (e.g. in tests).
  const fromEnv = process.env.KEIKO_UI_STATIC_ROOT;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui", "static");
}

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function loadLocalKeikoEnv(cwd: string, env: EnvSource): EnvSource {
  const file = join(cwd, ".env");
  if (!existsSync(file)) {
    return env;
  }
  const merged: Record<string, string | undefined> = { ...env };
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!LOCAL_DOTENV_ENV_NAME_ALLOWLIST.has(key)) continue;
    if (merged[key] !== undefined) continue;
    merged[key] = parseEnvValue(line.slice(equals + 1));
  }
  return merged;
}

function resolveUiConfigPath(parsed: UiCliArgs, env: EnvSource): string | undefined {
  return parsed.config ?? env.KEIKO_CONFIG_FILE;
}

function hasEnvValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function resolveRuntimeStateDir(cwd: string, env: EnvSource): string {
  const raw = env.KEIKO_STATE_DIR;
  if (hasEnvValue(raw)) {
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  }
  return resolve(cwd, DEFAULT_STATE_DIR);
}

// `process.started`'s label for how the state directory was resolved. `keiko ui` has no
// `--state-dir` flag today (unlike `keiko start`'s `lifecycle.ts`), so `cli-flag` is not yet
// reachable — it stays in the union so a future flag does not need a wire-format change, and so
// this stays the single source an agent reconstructing a run reads the label from.
export type StateDirSource = "default" | "env-override" | "cli-flag";

function resolveStateDirSource(env: EnvSource): StateDirSource {
  return hasEnvValue(env.KEIKO_STATE_DIR) ? "env-override" : "default";
}

// Takes the ALREADY-RESOLVED state directory rather than resolving its own: the activity-log sink
// opens `<stateDir>/logs` and must land in the same place the runtime env points the child at, so
// `resolveRuntimeStateDir` runs once per launch and both consumers read that one value.
function withDefaultLocalRuntimeStateEnv(
  stateDir: string,
  parsed: UiCliArgs,
  env: EnvSource,
): EnvSource {
  const next: Record<string, string | undefined> = {
    ...env,
    KEIKO_STATE_DIR: stateDir,
    KEIKO_UI_HOST: UI_HOST,
    KEIKO_UI_PORT: String(parsed.port),
  };
  if (parsed.uiDbPath === undefined && !hasEnvValue(next.KEIKO_UI_DATA_DIR)) {
    next.KEIKO_UI_DATA_DIR = defaultUiDataDir(stateDir);
  }
  if (!hasEnvValue(next.KEIKO_MEMORY_DIR)) {
    next.KEIKO_MEMORY_DIR = join(stateDir, "memory");
  }
  // Guarded on `parsed.evidenceDir`, unlike `KEIKO_MEMORY_DIR` above (which has no CLI flag
  // counterpart): an explicit `--evidence-dir` must win in the child's env too, the same way
  // `KEIKO_UI_DATA_DIR`'s default above is guarded on `parsed.uiDbPath`. Baking the DEFAULT in
  // regardless would leak the wrong evidence directory to anything that inherits this env and
  // reads `KEIKO_EVIDENCE_DIR` directly rather than re-deriving `EvidenceStore`'s own precedence.
  if (parsed.evidenceDir === undefined && !hasEnvValue(next.KEIKO_EVIDENCE_DIR)) {
    next.KEIKO_EVIDENCE_DIR = join(stateDir, "evidence");
  }
  return next;
}

// Conservative request/header timeouts on the loopback BFF (defense in depth, L2/L3): even on
// 127.0.0.1 a slow or stuck client must not hold a connection indefinitely. headersTimeout must be
// at or below requestTimeout so an incomplete request line/header set is cut first.
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

function applyServerTimeouts(server: Server): void {
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, UI_HOST, res);
  });
}

// `server.close()` only stops NEW connections — it waits forever for in-flight
// responses, and the BFF holds long-lived SSE streams (chat tokens, run events)
// that never end on their own. A SIGTERM with one chat tab open therefore hung
// the process until SIGKILL. After signalling close, idle keep-alive sockets are
// dropped immediately and any still-active connection (the SSE streams) is
// force-terminated once a bounded grace window has passed, so shutdown always
// completes; their `close` handlers still run, releasing subscriptions.
const SHUTDOWN_FORCE_CLOSE_GRACE_MS = 3_000;

// The reason label `process.exiting` carries. `waitForShutdown`'s own handlers only ever produce
// the first three; `fatal-exception` is reserved for a future top-level uncaught-exception/
// unhandled-rejection handler outside this work item's scope, kept here so that producer can reuse
// the same closed vocabulary instead of inventing a second one.
export type ProcessExitReason = "sigint" | "sigterm" | "server-close" | "fatal-exception";

// What `waitForShutdown` needs to report the process-lifecycle exit line and release the
// heartbeat resources `startUiServer` scheduled. All optional: the injected-server test path
// (and any direct unit test of `waitForShutdown` itself) may supply none of it.
export interface WaitForShutdownActivity {
  readonly activityLog?: ServerLogSink | undefined;
  readonly startedAt?: number | undefined;
  // Stops the heartbeat interval and disables its event-loop-delay histogram. Called on every
  // shutdown branch, before the log line — a stop that itself threw must not suppress the line.
  readonly onShutdown?: (() => void) | undefined;
  // The loaded server module's `closeFileServerLogSinks` (ADR-0173 export), threaded in by
  // `startUiServer` on the real launch path, where the module is already loaded. Closes every
  // registered file sink by resolved log directory — the same descriptor `activityLog.close?.()`
  // would close (`keiko ui` only ever opens one) — without needing a second reference to the
  // module here. Left `undefined` on the injected-server test path (and any direct unit test of
  // `waitForShutdown`), which never loads the real server module; `writeProcessExiting` falls back
  // to `activityLog.close?.()` in that case, since both close the same resource.
  readonly closeActivityLog?: (() => void) | undefined;
}

function writeProcessExiting(activity: WaitForShutdownActivity, reason: ProcessExitReason): void {
  // A throwing onShutdown must not suppress this line (see WaitForShutdownActivity's doc
  // comment) — caught here rather than left to propagate into the SIGINT/SIGTERM/server-close
  // listener that calls this function, which would turn a heartbeat-teardown failure into an
  // uncaught exception on the shutdown path itself. The failure is not swallowed silently: it is
  // recorded on the very line it must not suppress, so an agent reconstructing this shutdown from
  // the log still sees it.
  // Only the error's CLASS is recorded, never its message: a message is foreign free text, and
  // the producer side never reads one — the same rule every other instrumentation site follows.
  let onShutdownErrorKind: string | undefined;
  try {
    activity.onShutdown?.();
  } catch (error) {
    onShutdownErrorKind = error instanceof Error ? error.name : typeof error;
  }
  const { activityLog, startedAt, closeActivityLog } = activity;
  if (activityLog === undefined || startedAt === undefined) return;
  activityLog.write({
    category: "process",
    op: "process.exiting",
    extra: {
      reason,
      uptimeMs: Date.now() - startedAt,
      ...(onShutdownErrorKind === undefined ? {} : { onShutdownErrorKind }),
    },
  });
  if (closeActivityLog !== undefined) {
    closeActivityLog();
  } else {
    activityLog.close?.();
  }
}

// Keeps the real-CLI process alive until a shutdown signal or server close. Resolves cleanly so
// the caller can return 0. Registered listeners are removed on resolve to prevent leaks.
export function waitForShutdown(
  server: Server,
  forceCloseGraceMs = SHUTDOWN_FORCE_CLOSE_GRACE_MS,
  activity: WaitForShutdownActivity = {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (): void => {
      if (forceTimer !== null) {
        clearTimeout(forceTimer);
        forceTimer = null;
      }
      resolve();
    };
    const onClose = (): void => {
      writeProcessExiting(activity, "server-close");
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      settle();
    };
    const onSignal = (reason: "sigint" | "sigterm"): void => {
      writeProcessExiting(activity, reason);
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      server.removeListener("close", onClose);
      server.closeIdleConnections();
      forceTimer = setTimeout(() => {
        server.closeAllConnections();
      }, forceCloseGraceMs);
      // The grace timer must never be what keeps the process alive.
      forceTimer.unref();
      server.close(() => {
        settle();
      });
    };
    const handleSigint = (): void => {
      onSignal("sigint");
    };
    const handleSigterm = (): void => {
      onSignal("sigterm");
    };
    server.once("close", onClose);
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
  });
}

// Default probe: try to require node:sqlite. Any failure (ERR_UNKNOWN_BUILTIN_MODULE on early
// an older runtime, or a thrown ExperimentalWarning that escaped) means we need the flag. The require is
// guarded inside a try; we never throw past here.
function defaultSqliteProbe(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

// Returns true if `--experimental-sqlite` is already on execArgv, meaning we are inside the child
// already and must not loop. Inspects both the supplied execArgv source (Node-level flags the
// parent inherited) AND NODE_OPTIONS (where the flag may live in env).
function alreadyFlagged(env: EnvSource, execArgv: readonly string[]): boolean {
  if (execArgv.includes(SQLITE_FLAG)) return true;
  const nodeOptions = env.NODE_OPTIONS;
  return typeof nodeOptions === "string" && nodeOptions.includes(SQLITE_FLAG);
}

// Re-spawns the current process with --experimental-sqlite prepended, inheriting stdio. Returns
// the exit code the child terminated with so the parent can propagate it.
async function reExecWithSqliteFlag(
  _env: EnvSource,
  spawnFn: SpawnFn,
  cwd: string,
): Promise<number> {
  const entry = resolvePreferredInstallLayout(cwd)?.binPath ?? process.argv[1];
  if (entry === undefined) return 1;
  const childArgs: string[] = [SQLITE_FLAG, ...process.execArgv, entry, ...process.argv.slice(2)];
  const child = spawnFn(process.execPath, childArgs, {
    argv0: KEIKO_PROCESS_TITLE,
    stdio: "inherit",
  });
  const forwardSigint = (): void => {
    child.kill("SIGINT");
  };
  const forwardSigterm = (): void => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", forwardSigint);
  process.on("SIGTERM", forwardSigterm);
  return new Promise<number>((res) => {
    const removeForwarders = (): void => {
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
    };
    // Without this, an async spawn failure (EMFILE, revoked exec permission)
    // throws the unlistened 'error' event and crashes the sqlite re-exec guard
    // with a raw stack instead of a clean non-zero exit.
    child.once("error", () => {
      removeForwarders();
      res(1);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      removeForwarders();
      if (typeof code === "number") {
        res(code);
        return;
      }
      res(signal === null ? 1 : 128);
    });
  });
}

// Returns undefined when no re-exec is needed; returns the child's exit code when a re-exec
// happened. The guard never runs when an injected test factory bypasses the production loop, and
// it never re-loops once --experimental-sqlite is already in execArgv.
async function maybeReExecForSqlite(
  env: EnvSource,
  deps: UiCliDeps,
  cwd: string,
): Promise<number | undefined> {
  if (deps.createServer !== undefined) return undefined;
  const execArgv = (deps.currentExecArgv ?? ((): readonly string[] => process.execArgv))();
  if (alreadyFlagged(env, execArgv)) return undefined;
  const probe = deps.sqliteProbe ?? defaultSqliteProbe;
  if (probe()) return undefined;
  const spawnFn = deps.spawnFn ?? spawn;
  return reExecWithSqliteFlag(env, spawnFn, cwd);
}

async function buildHandlerDepsOrReport(
  parsed: UiCliArgs,
  cwd: string,
  effectiveEnv: EnvSource,
  io: CliIo,
): Promise<UiHandlerDeps | number> {
  const { buildUiHandlerDeps, UiStoreError } = await loadServerModule();
  try {
    return buildUiHandlerDeps({
      configPath: resolveUiConfigPath(parsed, effectiveEnv),
      evidenceDir: parsed.evidenceDir,
      uiDbPath: parsed.uiDbPath,
      initialProjectPath: cwd,
      env: effectiveEnv,
    });
  } catch (error) {
    if (error instanceof UiStoreError) {
      io.err(`keiko ui: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

async function registerLaunchProjectOrReport(
  cwd: string,
  handlerDeps: UiHandlerDeps,
  io: CliIo,
): Promise<number | null> {
  const { UiStoreError } = await loadServerModule();
  try {
    handlerDeps.store.createProject(cwd);
    return null;
  } catch (error) {
    if (error instanceof UiStoreError) {
      io.err(`keiko ui: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function ensureStaticRoot(staticRoot: string, io: CliIo): boolean {
  if (existsSync(staticRoot)) {
    return true;
  }
  io.err(`keiko ui: UI assets not found at ${staticRoot}. Run \`npm run build:ui\` first.\n`);
  return false;
}

function parseUiArgsOrExit(args: readonly string[], io: CliIo): UiCliArgs | number {
  const parsed = parseUiArgs(args);
  if (parsed === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  return parsed;
}

async function maybeWaitForShutdown(
  server: Server,
  deps: UiCliDeps,
  activity: WaitForShutdownActivity,
): Promise<void> {
  if (deps.createServer !== undefined) {
    return;
  }
  await waitForShutdown(server, SHUTDOWN_FORCE_CLOSE_GRACE_MS, activity);
}

// `process.heartbeat` fires roughly once a minute — frequent enough that an agent reconstructing a
// stuck run always finds one within a minute of the wedge, cheap enough to run for the life of the
// process without its own volume control.
const HEARTBEAT_INTERVAL_MS = 60_000;

type EventLoopHistogram = ReturnType<typeof monitorEventLoopDelay>;
// `percentile()` reports nanoseconds; the log field is documented in milliseconds.
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function writeHeartbeat(activityLog: ServerLogSink, histogram: EventLoopHistogram): void {
  const memory = process.memoryUsage();
  activityLog.write({
    level: "info",
    category: "process",
    op: "process.heartbeat",
    extra: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      eventLoopDelayP99Ms: histogram.percentile(99) / NANOSECONDS_PER_MILLISECOND,
    },
  });
}

// Started once, right after `process.started` is written; stopped from the SAME callback that
// `waitForShutdown` invokes on every shutdown branch. `unref()`'d so it can never by itself keep a
// one-shot command alive, and only ever scheduled here — never at CLI module scope — preserving
// GEN-PERF-CLI-001's per-command budget. Exported so the interval/histogram lifecycle (started,
// produces a line, fully released on stop) can be unit-tested directly without booting a server.
export function startProcessHeartbeat(
  activityLog: ServerLogSink,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const histogram = monitorEventLoopDelay();
  histogram.enable();
  const interval = setInterval(() => {
    writeHeartbeat(activityLog, histogram);
  }, intervalMs);
  interval.unref();
  return (): void => {
    clearInterval(interval);
    histogram.disable();
  };
}

// `detectUpdateInstallMode`/`productionUpdateFacts` (ADR-0173 exports) are called directly rather
// than going through `createUpdateSessionManager({}).getStatus()`: both are the exact pair
// `UpdateSessionManagerImpl.getStatus()` already calls under the hood (`defaultDetectorFor` in
// `update-session-support.ts`), so this is the same synchronous, lock-free filesystem probe with
// no behavioural difference — just without constructing a full update-session manager (redactor,
// run-history slots, command-execution wiring, an optional lock) that `process.started` has no use
// for. `detectPortableUpdateInstallMode` alone (also exported) is deliberately NOT used here: it
// answers only the portable branch and returns `undefined` for every non-portable install — the
// common case — so on its own it cannot answer "which install mode is this process running in".
// Only ever called on the real CLI path (never the injected-server test path): the detector walks
// the filesystem from `process.argv[1]` looking for this package's own `package.json`, which is
// environment-dependent and would make every injected-server test's `process.started` line
// non-deterministic.
async function resolveInstallModeKind(): Promise<UpdateInstallModeKind | undefined> {
  const { detectUpdateInstallMode, productionUpdateFacts } = await loadServerModule();
  return detectUpdateInstallMode(productionUpdateFacts(process.env), process.env).installKind;
}

interface ProcessStartedContext {
  readonly activityLog: ServerLogSink | undefined;
  readonly isRealLaunch: boolean;
  readonly parsed: UiCliArgs;
  readonly handlerDeps: UiHandlerDeps;
  readonly stateDirSource: StateDirSource;
  readonly logLevel: string;
}

// Writes `process.started` (when an activity log is in scope) and, on the real CLI path only,
// schedules the heartbeat. Returns the heartbeat's stop callback so the caller can thread it into
// `waitForShutdown`; returns `undefined` when there is nothing to stop (no activity log, or the
// injected-server test path, which never schedules a heartbeat in the first place).
async function reportProcessStarted(
  context: ProcessStartedContext,
): Promise<(() => void) | undefined> {
  const { activityLog, isRealLaunch, parsed, handlerDeps, stateDirSource, logLevel } = context;
  if (activityLog === undefined) return undefined;
  const installMode = isRealLaunch ? await resolveInstallModeKind() : undefined;
  const gatewayProviderCount = handlerDeps.config?.providers.length;
  // No `instanceId` in `extra` here: `instanceId` is a RESERVED field name
  // (`log-redaction.ts`'s `RESERVED_FIELD_NAMES`), so `redactLogFields` silently drops it from
  // `extra` the same way it drops any other reserved name a caller supplies — see
  // `redactLogObject`'s `if (reserved?.has(name) === true) continue`. Every line the file sink
  // writes already carries `instanceId` in its envelope (`identity.instanceId`, stamped at the
  // physical write boundary in `server-log.ts`), so the invariant this field exists for — the
  // manifest and the log agreeing on which process wrote a line — already holds without it.
  activityLog.write({
    level: "info",
    category: "process",
    op: "process.started",
    extra: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      productVersion: KEIKO_PRODUCT_VERSION,
      host: UI_HOST,
      port: parsed.port,
      stateDirSource,
      logLevel,
      ...(installMode === undefined ? {} : { installMode }),
      ...(gatewayProviderCount === undefined ? {} : { gatewayProviderCount }),
    },
  });
  return isRealLaunch ? startProcessHeartbeat(activityLog) : undefined;
}

// One options object rather than a positional list: the parameters are all context for the same
// launch, and the list had grown past the point where a call site reads correctly.
interface StartUiServerOptions {
  readonly staticRoot: string;
  readonly csp: string;
  readonly cspProvider: (() => string | Promise<string>) | undefined;
  readonly parsed: UiCliArgs;
  readonly handlerDeps: UiHandlerDeps;
  readonly io: CliIo;
  readonly deps: UiCliDeps;
  readonly stateDir: string;
  readonly stateDirSource: StateDirSource;
  readonly logLevel: string;
}

async function startUiServer(options: StartUiServerOptions): Promise<void> {
  const { staticRoot, csp, cspProvider, parsed, handlerDeps, io, deps, stateDir } = options;
  const { stateDirSource, logLevel } = options;
  const isRealLaunch = deps.createServer === undefined;
  // Injected-server tests must not force-load the real server module graph. The same rule governs
  // the activity log: `createFileServerLogSink` mkdirs `<stateDir>/logs` on construction, so
  // building it on the injected path would write a directory outside the test's fixture. A test
  // may still inject its own sink via `deps.activityLog` to exercise the lifecycle log lines
  // without either of those.
  const factory = deps.createServer ?? (await loadServerModule()).createUiServer;
  const activityLog: ServerLogSink | undefined =
    deps.activityLog ??
    (isRealLaunch ? (await loadServerModule()).createFileServerLogSink(stateDir) : undefined);
  // Reaches the loaded module's `closeFileServerLogSinks` (ADR-0173 export) directly for the
  // shutdown path, rather than relying solely on `activityLog.close?.()` — see
  // `WaitForShutdownActivity.closeActivityLog`'s doc comment. `loadServerModule()` here is the
  // same memoized call the factory/activityLog lines above already made, so this costs nothing
  // extra on the real launch path and is never reached on the injected-server path.
  const closeActivityLog = isRealLaunch
    ? (await loadServerModule()).closeFileServerLogSinks
    : undefined;
  const server = await factory({
    staticRoot,
    csp,
    ...(cspProvider === undefined ? {} : { cspProvider }),
    port: parsed.port,
    handlerDeps,
    ...(activityLog === undefined ? {} : { activityLog }),
  });
  applyServerTimeouts(server);
  await listen(server, parsed.port);
  const startedAt = Date.now();
  // Printed before the (possibly filesystem-probing, on the real launch path) `process.started`
  // write below, so the operator's terminal reports "listening" the instant it is true rather
  // than waiting on install-mode detection.
  io.out(`Keiko UI listening on http://${UI_HOST}:${String(parsed.port)}\n`);
  const stopHeartbeat = await reportProcessStarted({
    activityLog,
    isRealLaunch,
    parsed,
    handlerDeps,
    stateDirSource,
    logLevel,
  });
  // Block only in the real CLI path (no injected factory). Injected-server tests skip blocking so
  // they don't hang; the real process must stay alive until signalled.
  await maybeWaitForShutdown(server, deps, {
    activityLog,
    startedAt,
    onShutdown: stopHeartbeat,
    closeActivityLog,
  });
}

export async function createLiveCspSource(
  staticRoot: string,
  hashesFile: string,
  io: CliIo,
): Promise<LiveCspSource> {
  let current = (await loadCspMaterial(staticRoot, hashesFile)).header;
  let reloading = false;
  let disposed = false;
  let warned = false;

  const reload = async (): Promise<void> => {
    if (reloading || disposed) return;
    reloading = true;
    try {
      current = (await loadCspMaterial(staticRoot, hashesFile)).header;
      warned = false;
    } catch (error) {
      if (!warned) {
        const message = error instanceof Error ? error.message : String(error);
        io.err(`Warning: failed to reload CSP hashes from ${hashesFile}: ${message}\n`);
        warned = true;
      }
    } finally {
      reloading = false;
    }
  };

  // Issue #1214 follow-up: when the UI process starts while build:ui is still writing the static
  // export and `csp-hashes.json`, a one-shot CSP read can freeze a stale policy into the process.
  // Watching the hash file keeps fresh page loads aligned with the latest exported inline scripts.
  watchFile(hashesFile, { interval: 500 }, () => {
    void reload();
  });

  return {
    csp: () => current,
    dispose: (): void => {
      disposed = true;
      unwatchFile(hashesFile);
    },
  };
}

// Builds the handler deps, registers the launch project, runs the server, and —
// on EVERY exit path, early error returns included — releases the shared sqlite
// handle on the real CLI path (mirrors maybeWaitForShutdown's injected-server
// gate: tests keep the deps alive so they can assert against the store after
// runUiCli returns). Closing explicitly checkpoints the WAL instead of relying
// on process exit to drop the WAL/-shm files in an arbitrary state.
interface CspSnapshot {
  readonly csp: string;
  readonly cspProvider: (() => string | Promise<string>) | undefined;
}

async function launchUiFromDeps(
  parsed: UiCliArgs,
  staticRoot: string,
  csp: CspSnapshot,
  cwd: string,
  effectiveEnv: EnvSource,
  io: CliIo,
  deps: UiCliDeps,
): Promise<number> {
  const stateDir = resolveRuntimeStateDir(cwd, effectiveEnv);
  // Captured from the ORIGINAL env, before `withDefaultLocalRuntimeStateEnv` unconditionally sets
  // `KEIKO_STATE_DIR` on the derived copy below — otherwise every launch would read back as
  // `env-override` regardless of what the operator actually configured.
  const stateDirSource = resolveStateDirSource(effectiveEnv);
  // `resolveServerLogThreshold` (ADR-0173 export) replaces a local mirror of
  // `observability/log-level.ts`'s env name, default, and alias table that had to duplicate that
  // module's normalisation rules under a different name because neither was reachable through
  // `loadServerModule()` before. Loading the server module here is not the GEN-PERF-CLI-001 cost
  // this file otherwise guards against: `runUiCli` already unconditionally loads it for CSP header
  // material (`loadCspMaterial`, above) before this point is ever reached, on the real launch path
  // and the injected-server test path alike — this is a second, memoized, already-cached call, not
  // a new load.
  const logLevel = (await loadServerModule()).resolveServerLogThreshold(effectiveEnv);
  const handlerDeps = await buildHandlerDepsOrReport(
    parsed,
    cwd,
    withDefaultLocalRuntimeStateEnv(stateDir, parsed, effectiveEnv),
    io,
  );
  if (typeof handlerDeps === "number") return handlerDeps;
  try {
    const launchProjectResult = await registerLaunchProjectOrReport(cwd, handlerDeps, io);
    if (launchProjectResult !== null) return launchProjectResult;
    await startUiServer({
      staticRoot,
      csp: csp.csp,
      cspProvider: csp.cspProvider,
      parsed,
      handlerDeps,
      io,
      deps,
      stateDir,
      stateDirSource,
      logLevel,
    });
    return 0;
  } finally {
    if (deps.createServer === undefined) await handlerDeps.dispose?.();
  }
}

export async function runUiCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: UiCliDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const effectiveEnv = loadLocalKeikoEnv(cwd, env);
  const parsed = parseUiArgsOrExit(args, io);
  if (typeof parsed === "number") return parsed;
  const reExec = await maybeReExecForSqlite(effectiveEnv, deps, cwd);
  if (reExec !== undefined) return reExec;
  const staticRoot = deps.staticRoot ?? defaultStaticRoot(cwd);
  if (!ensureStaticRoot(staticRoot, io)) {
    return 1;
  }
  const cspRuntime = await createLiveCspSource(
    staticRoot,
    deps.hashesFile ?? join(staticRoot, "..", "csp-hashes.json"),
    io,
  );
  // The finally now covers the deps-build error paths too: previously an early
  // return there leaked the csp-hashes file watcher for the process lifetime.
  try {
    // Pass BOTH the startup snapshot (compat + fallback) and the live accessor. The server picks
    // the fresher of the two via `(await cspProvider?.()) ?? csp` — KEIKO-0439 traced Issue-#1214's
    // "UI blank until restart after a rebuild" back to the CLI passing only the snapshot.
    return await launchUiFromDeps(
      parsed,
      staticRoot,
      { csp: cspRuntime.csp(), cspProvider: cspRuntime.csp },
      cwd,
      effectiveEnv,
      io,
      deps,
    );
  } finally {
    cspRuntime.dispose();
  }
}
