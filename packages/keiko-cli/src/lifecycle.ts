import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { DEFAULT_UI_PORT, UI_HOST } from "@oscharko-dev/keiko-server";
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
  keiko start [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH]
  keiko stop [--state-dir PATH]
  keiko restart [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH]
  keiko status [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH]

Manages the local Keiko UI process. Runtime state is written to .keiko/ by default.
`;

interface LifecycleOptions {
  readonly port: number;
  readonly host: string;
  readonly stateDir: string;
  readonly startTimeoutMs: number;
  readonly stopTimeoutMs: number;
}

interface RawLifecycleOptions {
  portRaw?: string | undefined;
  hostRaw?: string | undefined;
  stateDirRaw?: string | undefined;
  startTimeoutRaw?: string | undefined;
  stopTimeoutRaw?: string | undefined;
}

export interface LifecycleCliDeps {
  readonly cwd?: string | undefined;
  readonly spawnFn?: SpawnFn | undefined;
  readonly fetchImpl?: FetchFn | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
  readonly killProcess?: ProcessKiller | undefined;
  readonly isPortAvailable?: PortAvailabilityFn | undefined;
}

interface LifecycleRuntimeDeps {
  readonly spawnFn: SpawnFn;
  readonly fetchImpl: FetchFn;
  readonly sleep: SleepFn;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly killProcess: ProcessKiller;
  readonly isPortAvailable: PortAvailabilityFn;
}

interface HealthProbeResult {
  readonly reachable: boolean;
  readonly version: string | undefined;
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

function pidFile(options: LifecycleOptions): string {
  return join(options.stateDir, "ui.pid");
}

function logFile(options: LifecycleOptions): string {
  return join(options.stateDir, "ui.log");
}

function healthUrl(options: LifecycleOptions): string {
  return `http://${options.host}:${String(options.port)}/api/health`;
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

function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
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
  const path = pidFile(options);
  const pid = readPid(path);
  if (pid === undefined) {
    rmSync(path, { force: true });
    return undefined;
  }
  if (!isAlive(pid)) {
    rmSync(path, { force: true });
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

function cliEntryPath(): string {
  // The root bin entry (`dist/cli/index.js`) surfaces `KEIKO_CLI_BIN_PATH` so
  // re-exec'd children spawned by `keiko start` invoke the published bin rather
  // than the cli package barrel (which is not executable). The
  // import.meta.url fallback preserves direct package-local invocation for callers
  // that invoke runLifecycleCli without going through the published bin entry.
  const fromEnv = process.env.KEIKO_CLI_BIN_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

function spawnUiProcess(
  options: LifecycleOptions,
  env: EnvSource,
  deps: Pick<LifecycleRuntimeDeps, "spawnFn">,
  cwd: string,
): { readonly child: ChildProcess; readonly logPath: string } {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const logPath = logFile(options);
  const fd = openSync(logPath, "a", 0o600);
  const uiEnv = childEnv({ ...env, KEIKO_STATE_DIR: options.stateDir });
  try {
    return {
      child: deps.spawnFn(
        process.execPath,
        [cliEntryPath(), "ui", "--port", String(options.port), "--host", options.host],
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
    try {
      const response = await deps.fetchImpl(healthUrl(options), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && deps.isProcessAlive(pid)) {
        return true;
      }
    } catch {
      // Startup is still in progress.
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
  const running = runningPid(options, deps.isProcessAlive);
  if (running !== undefined) {
    const health = await probeHealth(options, deps.fetchImpl);
    if (health.version === SDK_VERSION) {
      io.out(
        `Keiko UI already running on ${healthUrl(options).replace("/api/health", "")} (pid ${String(running)}).\n`,
      );
      return 0;
    }
    const reason = !health.reachable
      ? "health check is unreachable"
      : health.version === undefined
        ? "health check did not return the current Keiko version"
        : `running version ${health.version} differs from installed version ${SDK_VERSION}`;
    io.out(`Keiko UI process is stale (${reason}); restarting pid ${String(running)}.\n`);
    const stopped = await cmdStop(options, io, deps);
    if (stopped !== 0) return stopped;
  }

  if (!(await ensureStartPortAvailable(options, io, deps))) return 1;

  const { child, logPath } = spawnUiProcess(options, env, deps, cwd);

  if (child.pid === undefined) {
    io.err("keiko start: failed to spawn the UI process.\n");
    return 1;
  }
  child.unref();
  writeFileSync(pidFile(options), `${String(child.pid)}\n`, { encoding: "utf8", mode: 0o600 });
  io.out(`Starting Keiko UI on ${healthUrl(options).replace("/api/health", "")} ...\n`);

  const healthy = await waitForHealth(options, child.pid, deps);
  if (healthy) {
    io.out(
      `Keiko UI running on ${healthUrl(options).replace("/api/health", "")} (pid ${String(child.pid)}).\n`,
    );
    io.out(`Logs: ${logPath}\n`);
    return 0;
  }

  deps.killProcess(child.pid, "SIGTERM");
  rmSync(pidFile(options), { force: true });
  io.err(`keiko start: UI did not become healthy. Logs: ${logPath}\n`);
  return 1;
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
  io.out(`Stopping Keiko UI (pid ${String(pid)}) ...\n`);
  deps.killProcess(pid, "SIGTERM");
  const deadline = Date.now() + options.stopTimeoutMs;
  while (Date.now() <= deadline) {
    if (!deps.isProcessAlive(pid)) {
      rmSync(pidFile(options), { force: true });
      io.out("Keiko UI stopped.\n");
      return 0;
    }
    await deps.sleep(500);
  }

  io.err("keiko stop: UI did not exit gracefully; sending SIGKILL.\n");
  deps.killProcess(pid, "SIGKILL");
  await deps.sleep(500);
  if (deps.isProcessAlive(pid)) {
    io.err(`keiko stop: failed to stop pid ${String(pid)}.\n`);
    return 1;
  }
  rmSync(pidFile(options), { force: true });
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
  io.out(
    `Keiko UI is running on ${healthUrl(options).replace("/api/health", "")} (pid ${String(pid)}).\n`,
  );
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
