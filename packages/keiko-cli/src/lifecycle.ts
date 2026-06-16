import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { DEFAULT_UI_PORT, UI_HOST } from "@oscharko-dev/keiko-server";
import { type PreferredInstallLayout, resolvePreferredInstallLayout } from "./install-layout.js";
import {
  clearRuntimeState,
  isForeignLivePid,
  metaFilePath,
  pidFilePath,
  readPidFile,
  writeLaunchMetadata,
  writePidFile,
} from "./lifecycle-state.js";
import type { CliIo } from "./runner.js";

type LifecycleCommand = "start" | "stop" | "status" | "restart";
type SpawnFn = (command: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;
type ProcessKiller = (pid: number, signal?: NodeJS.Signals | 0) => void;
type PortAvailabilityFn = (host: string, port: number) => Promise<boolean>;
type LifecycleFlag = "--port" | "--host" | "--state-dir" | "--start-timeout" | "--stop-timeout";
type LifecycleFlagSetter = (raw: RawLifecycleOptions, value: string) => void;

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const LIFECYCLE_FLAG_SETTERS: Readonly<Record<LifecycleFlag, LifecycleFlagSetter>> = {
  "--port": (raw, value) => {
    raw.portRaw = value;
  },
  "--host": (raw, value) => {
    raw.hostRaw = value;
  },
  "--state-dir": (raw, value) => {
    raw.stateDirRaw = value;
  },
  "--start-timeout": (raw, value) => {
    raw.startTimeoutRaw = value;
  },
  "--stop-timeout": (raw, value) => {
    raw.stopTimeoutRaw = value;
  },
};

const USAGE = `Usage:
  keiko start [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH] [--open]
  keiko stop [--state-dir PATH]
  keiko restart [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH] [--open]
  keiko status [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH]

Manages the local Keiko UI process. Runtime state is written to .keiko/ by default.
`;

interface LifecycleOptions {
  readonly port: number;
  readonly host: string;
  readonly stateDir: string;
  readonly startTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly openBrowser: boolean;
}

interface RawLifecycleOptions {
  portRaw?: string | undefined;
  hostRaw?: string | undefined;
  stateDirRaw?: string | undefined;
  startTimeoutRaw?: string | undefined;
  stopTimeoutRaw?: string | undefined;
  openBrowser?: boolean | undefined;
}

export interface LifecycleCliDeps {
  readonly cwd?: string | undefined;
  readonly spawnFn?: SpawnFn | undefined;
  readonly fetchImpl?: FetchFn | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
  readonly killProcess?: ProcessKiller | undefined;
  readonly isPortAvailable?: PortAvailabilityFn | undefined;
  readonly openExternal?: ((url: string) => void) | undefined;
}

interface LifecycleRuntimeDeps {
  readonly spawnFn: SpawnFn;
  readonly fetchImpl: FetchFn;
  readonly sleep: SleepFn;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly killProcess: ProcessKiller;
  readonly isPortAvailable: PortAvailabilityFn;
  readonly openExternal: (url: string) => void;
}

interface HealthProbeResult {
  readonly reachable: boolean;
  readonly version: string | undefined;
}

function staleProcessReason(health: HealthProbeResult): string {
  if (!health.reachable) return "health check is unreachable";
  if (health.version === undefined) return "health check did not return the current Keiko version";
  return `running version ${health.version} differs from installed version ${SDK_VERSION}`;
}

function readFlagValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

function parsePositiveSeconds(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw) * 1000;
}

function optionOrEnv(
  value: string | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  return value ?? envValue ?? fallback;
}

function resolveStateDir(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function isLifecycleFlag(arg: string): arg is LifecycleFlag {
  return Object.prototype.hasOwnProperty.call(LIFECYCLE_FLAG_SETTERS, arg);
}

function collectLifecycleOptions(args: readonly string[]): RawLifecycleOptions | "help" | null {
  const raw: RawLifecycleOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return null;
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--open") {
      raw.openBrowser = true;
      continue;
    }
    if (!isLifecycleFlag(arg)) return null;
    const value = readFlagValue(args, i);
    if (value === null) return null;
    LIFECYCLE_FLAG_SETTERS[arg](raw, value);
    i += 1;
  }
  return raw;
}

function buildLifecycleOptions(
  raw: RawLifecycleOptions,
  cwd: string,
  env: EnvSource,
): LifecycleOptions | null {
  const port = parsePort(optionOrEnv(raw.portRaw, env.KEIKO_UI_PORT, String(DEFAULT_UI_PORT)));
  const host = optionOrEnv(raw.hostRaw, env.KEIKO_UI_HOST, UI_HOST);
  const startTimeoutMs = parsePositiveSeconds(
    optionOrEnv(raw.startTimeoutRaw, env.KEIKO_START_TIMEOUT_SECS, "20"),
  );
  const stopTimeoutMs = parsePositiveSeconds(
    optionOrEnv(raw.stopTimeoutRaw, env.KEIKO_STOP_TIMEOUT_SECS, "10"),
  );
  if (
    port === null ||
    !ALLOWED_HOSTS.has(host) ||
    startTimeoutMs === null ||
    stopTimeoutMs === null
  ) {
    return null;
  }
  return {
    port,
    host,
    stateDir: resolveStateDir(cwd, optionOrEnv(raw.stateDirRaw, env.KEIKO_STATE_DIR, ".keiko")),
    startTimeoutMs,
    stopTimeoutMs,
    openBrowser: raw.openBrowser === true,
  };
}

function parseLifecycleArgs(
  args: readonly string[],
  cwd: string,
  env: EnvSource,
): LifecycleOptions | "help" | null {
  const raw = collectLifecycleOptions(args);
  if (raw === "help" || raw === null) return raw;
  return buildLifecycleOptions(raw, cwd, env);
}

function logFile(options: LifecycleOptions): string {
  return join(options.stateDir, "ui.log");
}

function healthUrl(options: LifecycleOptions): string {
  return `http://${options.host}:${String(options.port)}/api/health`;
}

function lifecycleBaseUrl(options: LifecycleOptions): string {
  return healthUrl(options).replace("/api/health", "");
}

function healthVersion(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const version = (payload as { readonly version?: unknown }).version;
  return typeof version === "string" ? version : undefined;
}

async function probeHealth(
  options: LifecycleOptions,
  fetchImpl: FetchFn,
): Promise<HealthProbeResult> {
  try {
    const response = await fetchImpl(healthUrl(options), {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      return { reachable: false, version: undefined };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { reachable: true, version: undefined };
    }
    return { reachable: true, version: healthVersion(body) };
  } catch {
    return { reachable: false, version: undefined };
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function defaultIsPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolveAvailable) => {
    const server = createNetServer();
    let settled = false;
    const settle = (available: boolean): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners("error");
      server.removeAllListeners("listening");
      if (server.listening) {
        server.close(() => {
          resolveAvailable(available);
        });
        return;
      }
      resolveAvailable(available);
    };
    server.once("error", () => {
      settle(false);
    });
    server.once("listening", () => {
      settle(true);
    });
    server.listen(port, host);
  });
}

function runningPid(
  options: LifecycleOptions,
  isAlive: (pid: number) => boolean,
): number | undefined {
  const pid = readPidFile(options.stateDir);
  if (pid === undefined || !isAlive(pid)) {
    clearRuntimeState(options.stateDir);
    return undefined;
  }
  return pid;
}

function childEnv(env: EnvSource): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(env, key) && value !== undefined) {
      next[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function cliEntryPath(cwd: string, preferredLayout = resolvePreferredInstallLayout(cwd)): string {
  if (preferredLayout !== undefined) return preferredLayout.binPath;
  // The root bin entry (`dist/cli/index.js`) surfaces `KEIKO_CLI_BIN_PATH` so
  // re-exec'd children spawned by `keiko start` invoke the published bin rather
  // than the cli package barrel (which is not executable). The
  // import.meta.url fallback preserves direct package-local invocation for callers
  // that invoke runLifecycleCli without going through the published bin entry.
  const fromEnv = process.env.KEIKO_CLI_BIN_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

function defaultOpenExternal(url: string): void {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function maybeOpenBrowser(
  options: LifecycleOptions,
  io: CliIo,
  openExternal: (url: string) => void,
): void {
  if (!options.openBrowser) return;
  const baseUrl = lifecycleBaseUrl(options);
  try {
    openExternal(baseUrl);
  } catch {
    io.err(`keiko start: failed to open ${baseUrl} in the default browser.\n`);
  }
}

function reportHealthyStart(
  options: LifecycleOptions,
  io: CliIo,
  pid: number,
  logPath: string,
  openExternal: (url: string) => void,
): number {
  io.out(`Keiko UI running on ${lifecycleBaseUrl(options)} (pid ${String(pid)}).\n`);
  io.out(`Logs: ${logPath}\n`);
  maybeOpenBrowser(options, io, openExternal);
  return 0;
}

interface LaunchTarget {
  readonly binPath: string;
  readonly layout: PreferredInstallLayout | undefined;
}

// Resolve the launch binary and layout exactly once per start so the spawned
// command, its env, and the recorded metadata all agree on the same binary.
function resolveLaunchTarget(cwd: string): LaunchTarget {
  const layout = resolvePreferredInstallLayout(cwd);
  return { binPath: cliEntryPath(cwd, layout), layout };
}

function spawnUiProcess(
  options: LifecycleOptions,
  env: EnvSource,
  deps: Pick<LifecycleRuntimeDeps, "spawnFn">,
  cwd: string,
  target: LaunchTarget,
): { readonly child: ChildProcess; readonly logPath: string } {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const logPath = logFile(options);
  const fd = openSync(logPath, "a", 0o600);
  const uiEnv = childEnv({
    ...env,
    KEIKO_STATE_DIR: options.stateDir,
    ...(target.layout === undefined
      ? {}
      : {
          KEIKO_CLI_BIN_PATH: target.layout.binPath,
          KEIKO_UI_STATIC_ROOT: target.layout.staticRoot,
        }),
  });
  try {
    return {
      child: deps.spawnFn(
        process.execPath,
        [target.binPath, "ui", "--port", String(options.port), "--host", options.host],
        {
          cwd,
          detached: true,
          env: uiEnv,
          stdio: ["ignore", fd, fd],
        },
      ),
      logPath,
    };
  } finally {
    closeSync(fd);
  }
}

async function waitForHealth(
  options: LifecycleOptions,
  pid: number,
  deps: Pick<LifecycleRuntimeDeps, "fetchImpl" | "sleep" | "isProcessAlive">,
): Promise<boolean> {
  const deadline = Date.now() + options.startTimeoutMs;
  while (Date.now() <= deadline) {
    if (!deps.isProcessAlive(pid)) return false;
    const health = await probeHealth(options, deps.fetchImpl);
    if (health.version === SDK_VERSION && deps.isProcessAlive(pid)) {
      return true;
    }
    await deps.sleep(500);
  }
  return false;
}

async function ensureStartPortAvailable(
  options: LifecycleOptions,
  io: CliIo,
  deps: Pick<LifecycleRuntimeDeps, "isPortAvailable">,
): Promise<boolean> {
  if (await deps.isPortAvailable(options.host, options.port)) return true;
  io.err(
    `keiko start: port ${options.host}:${String(options.port)} is already in use. Stop the existing process or choose another port with --port.\n`,
  );
  return false;
}

async function cmdStart(
  options: LifecycleOptions,
  io: CliIo,
  env: EnvSource,
  deps: LifecycleRuntimeDeps,
  cwd: string,
): Promise<number> {
  const restart = await maybeStopStaleProcess(options, io, deps);
  if (restart !== "proceed") return restart;

  if (!(await ensureStartPortAvailable(options, io, deps))) return 1;

  const target = resolveLaunchTarget(cwd);
  const { child, logPath } = spawnUiProcess(options, env, deps, cwd, target);

  if (child.pid === undefined) {
    io.err("keiko start: failed to spawn the UI process.\n");
    return 1;
  }
  child.unref();
  writePidFile(options.stateDir, child.pid);
  writeLaunchMetadata(options.stateDir, child.pid, target.binPath);
  io.out(`Starting Keiko UI on ${lifecycleBaseUrl(options)} ...\n`);

  const healthy = await waitForHealth(options, child.pid, deps);
  if (healthy) return reportHealthyStart(options, io, child.pid, logPath, deps.openExternal);

  deps.killProcess(child.pid, "SIGTERM");
  clearRuntimeState(options.stateDir);
  io.err(`keiko start: UI did not become healthy. Logs: ${logPath}\n`);
  return 1;
}

// Returns "proceed" to continue starting, 0 when a healthy process is already
// running, or a non-zero exit code when a stale process could not be stopped.
async function maybeStopStaleProcess(
  options: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
): Promise<number | "proceed"> {
  const running = runningPid(options, deps.isProcessAlive);
  if (running === undefined) return "proceed";

  const health = await probeHealth(options, deps.fetchImpl);
  if (health.version === SDK_VERSION) {
    io.out(`Keiko UI already running on ${lifecycleBaseUrl(options)} (pid ${String(running)}).\n`);
    return 0;
  }
  io.out(
    `Keiko UI process is stale (${staleProcessReason(health)}); restarting pid ${String(running)}.\n`,
  );
  // A foreign-pid mismatch proves the live pid is no longer the process we
  // recorded, so cmdStop would refuse it. Clearing stale state and respawning is
  // safe here, and avoids a deadlock where neither start nor stop can proceed.
  if (isForeignLivePid(options.stateDir, running)) {
    clearRuntimeState(options.stateDir);
    return "proceed";
  }
  const stopped = await cmdStop(options, io, deps);
  return stopped === 0 ? "proceed" : stopped;
}

async function cmdStop(
  options: LifecycleOptions,
  io: CliIo,
  deps: Pick<LifecycleRuntimeDeps, "sleep" | "isProcessAlive" | "killProcess">,
): Promise<number> {
  const pid = runningPid(options, deps.isProcessAlive);
  if (pid === undefined) {
    io.out("Keiko UI is not running.\n");
    return 0;
  }
  if (isForeignLivePid(options.stateDir, pid)) {
    io.err(
      `keiko stop: pid ${String(pid)} is alive but the recorded pid in ${metaFilePath(options.stateDir)} does not match, so it is not the Keiko UI process we started. Refusing to signal an unrelated process. If this state is stale, remove both ${pidFilePath(options.stateDir)} and ${metaFilePath(options.stateDir)} before retrying.\n`,
    );
    return 1;
  }
  io.out(`Stopping Keiko UI (pid ${String(pid)}) ...\n`);
  deps.killProcess(pid, "SIGTERM");
  const deadline = Date.now() + options.stopTimeoutMs;
  while (Date.now() <= deadline) {
    if (!deps.isProcessAlive(pid)) {
      clearRuntimeState(options.stateDir);
      io.out("Keiko UI stopped.\n");
      return 0;
    }
    await deps.sleep(500);
  }

  io.err("keiko stop: UI did not exit gracefully; sending SIGKILL.\n");
  deps.killProcess(pid, "SIGKILL");
  // Sleep at most 500 ms but respect whatever budget remains in stopTimeoutMs.
  await deps.sleep(Math.max(0, Math.min(500, deadline - Date.now())));
  if (deps.isProcessAlive(pid)) {
    io.err(`keiko stop: failed to stop pid ${String(pid)}.\n`);
    return 1;
  }
  clearRuntimeState(options.stateDir);
  io.out("Keiko UI stopped (forced).\n");
  return 0;
}

function cmdStatus(
  options: LifecycleOptions,
  io: CliIo,
  isAlive: (pid: number) => boolean,
): number {
  const pid = runningPid(options, isAlive);
  if (pid === undefined) {
    io.out("Keiko UI is not running.\n");
    return 0;
  }
  io.out(`Keiko UI is running on ${lifecycleBaseUrl(options)} (pid ${String(pid)}).\n`);
  return 0;
}

async function cmdRestart(
  options: LifecycleOptions,
  io: CliIo,
  env: EnvSource,
  deps: LifecycleRuntimeDeps,
  cwd: string,
): Promise<number> {
  const stopped = await cmdStop(options, io, deps);
  if (stopped !== 0) return stopped;
  return cmdStart(options, io, env, deps, cwd);
}

function runtimeDeps(deps: LifecycleCliDeps): LifecycleRuntimeDeps {
  return {
    spawnFn: deps.spawnFn ?? spawn,
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep:
      deps.sleep ??
      ((ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    killProcess: deps.killProcess ?? process.kill.bind(process),
    isPortAvailable: deps.isPortAvailable ?? defaultIsPortAvailable,
    openExternal: deps.openExternal ?? defaultOpenExternal,
  };
}

export async function runLifecycleCli(
  command: LifecycleCommand,
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: LifecycleCliDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const options = parseLifecycleArgs(args, cwd, env);
  if (options === "help") {
    io.out(USAGE);
    return 0;
  }
  if (options === null) {
    io.err(USAGE);
    return 2;
  }

  const fullDeps = runtimeDeps(deps);

  const handlers: Readonly<Record<LifecycleCommand, () => Promise<number>>> = {
    start: () => cmdStart(options, io, env, fullDeps, cwd),
    stop: () => cmdStop(options, io, fullDeps),
    status: () => Promise.resolve(cmdStatus(options, io, fullDeps.isProcessAlive)),
    restart: () => cmdRestart(options, io, env, fullDeps, cwd),
  };
  return handlers[command]();
}
