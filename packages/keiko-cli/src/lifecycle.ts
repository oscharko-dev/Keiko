import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { get as httpGet } from "node:http";
import { homedir as defaultHomedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
// From the contracts leaf, NOT keiko-server or the keiko-sdk fat barrel: pulling the server
// module graph in eagerly here cost every `keiko` invocation ~410ms of ESM loading
// (GEN-PERF-CLI-001). Lifecycle needs the loopback endpoint constants plus the launcher half of
// the ADR-0141 app-session pairing hand-off (#2478); the claim-minting keiko-server import stays
// dynamic inside the `--open` path.
import {
  CODING_APP_SESSION_LAUNCHER_SECRET_ENV,
  CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS,
  KEIKO_PRODUCT_VERSION as SDK_VERSION,
  encodeCodingAppSessionPairingFragment,
} from "@oscharko-dev/keiko-contracts";
import { absoluteExistingPath, resolvePreferredInstallLayout } from "./install-layout.js";
import { LauncherError } from "./launcher-platforms.js";
import { resolveLoopbackEndpoint } from "./loopback-endpoint.js";
import type { CliIo } from "./runner.js";
import { resolveContainedStateDir } from "./state-paths.js";

type LifecycleCommand = "start" | "stop" | "status" | "restart";
type SpawnFn = (command: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type HealthProbeFn = (url: string) => Promise<HealthProbeResult>;
type SleepFn = (ms: number) => Promise<void>;
type ProcessKiller = (pid: number, signal?: NodeJS.Signals | 0) => void;
type PortAvailabilityFn = (host: string, port: number) => Promise<boolean>;
type LifecycleFlag = "--port" | "--host" | "--state-dir" | "--start-timeout" | "--stop-timeout";
type LifecycleFlagSetter = (raw: RawLifecycleOptions, value: string) => void;

const KEIKO_PROCESS_TITLE = "Keiko";
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
  readonly homedir?: (() => string) | undefined;
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
  readonly healthProbe: HealthProbeFn;
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

const HEALTH_PROBE_TIMEOUT_MS = 1_000;
const HEALTH_RESPONSE_MAX_BYTES = 64 * 1024;

interface UiLogStdio {
  readonly logPath: string;
  readonly stdio: StdioOptions;
  readonly close: () => void;
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

function isLifecycleFlag(arg: string): arg is LifecycleFlag {
  return Object.hasOwn(LIFECYCLE_FLAG_SETTERS, arg);
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
  home: string,
): LifecycleOptions | null {
  const endpoint = resolveLoopbackEndpoint({ host: raw.hostRaw, port: raw.portRaw }, env);
  const startTimeoutMs = parsePositiveSeconds(
    optionOrEnv(raw.startTimeoutRaw, env.KEIKO_START_TIMEOUT_SECS, "20"),
  );
  const stopTimeoutMs = parsePositiveSeconds(
    optionOrEnv(raw.stopTimeoutRaw, env.KEIKO_STOP_TIMEOUT_SECS, "10"),
  );
  if (endpoint === null || startTimeoutMs === null || stopTimeoutMs === null) {
    return null;
  }
  // #KEIKO-0330: route KEIKO_STATE_DIR / --state-dir through the same home-containment
  // guard `keiko launcher` enforces. An env-planted or CLI-injected value that resolves
  // outside the user's home throws `STATE_DIR_ESCAPE`, caught in `runLifecycleCli`.
  return {
    port: endpoint.port,
    host: endpoint.host,
    stateDir: resolveContainedStateDir(cwd, env, home, raw.stateDirRaw),
    startTimeoutMs,
    stopTimeoutMs,
    openBrowser: raw.openBrowser === true,
  };
}

function parseLifecycleArgs(
  args: readonly string[],
  cwd: string,
  env: EnvSource,
  home: string,
): LifecycleOptions | "help" | null {
  const raw = collectLifecycleOptions(args);
  if (raw === "help" || raw === null) return raw;
  return buildLifecycleOptions(raw, cwd, env, home);
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

function lifecycleBaseUrl(options: LifecycleOptions): string {
  return healthUrl(options).replace("/api/health", "");
}

function healthVersion(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const version = (payload as { readonly version?: unknown }).version;
  return typeof version === "string" ? version : undefined;
}

function healthResult(statusCode: number | undefined, body: string): HealthProbeResult {
  if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
    return { reachable: false, version: undefined };
  }
  try {
    return { reachable: true, version: healthVersion(JSON.parse(body) as unknown) };
  } catch {
    return { reachable: true, version: undefined };
  }
}

function defaultHealthProbe(url: string): Promise<HealthProbeResult> {
  return new Promise((resolveProbe) => {
    const request = httpGet(url, { timeout: HEALTH_PROBE_TIMEOUT_MS }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > HEALTH_RESPONSE_MAX_BYTES) {
          response.destroy();
          resolveProbe({ reachable: true, version: undefined });
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        resolveProbe(healthResult(response.statusCode, Buffer.concat(chunks).toString("utf8")));
      });
      response.once("error", () => {
        resolveProbe({ reachable: false, version: undefined });
      });
    });
    request.once("timeout", () => {
      request.destroy();
    });
    request.once("error", () => {
      resolveProbe({ reachable: false, version: undefined });
    });
  });
}

async function fetchHealthProbe(url: string, fetchImpl: FetchFn): Promise<HealthProbeResult> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    return healthResult(response.status, await response.text());
  } catch {
    return { reachable: false, version: undefined };
  }
}

// Small bound on <stateDir>/ui.pid: it holds one decimal pid plus a newline, never more.
const MAX_PID_FILE_BYTES = 64;

// KEIKO-0886 follow-up (#2906 review, comment 3863185744): the pid file used to be opened via a
// separate `lstatSync` CHECK followed by a SEPARATE `writeFileSync`/`readFileSync` USE -- a
// symlink planted in the window between the two was followed (readPid had no check at all;
// readFileSync always follows symlinks). `readPid` then feeds whatever it parsed straight to
// `isProcessAlive`/`process.kill`, so a followed symlink could steer a real signal at an
// attacker-chosen pid. Opening the descriptor with `O_NOFOLLOW` makes the check and the use the
// SAME syscall on POSIX, closing the window entirely: a symlink at the final path component
// fails the open() itself (ELOOP), whether it was there from the start or planted a moment
// before. Windows has no `O_NOFOLLOW`; this falls back to the same lstatSync-then-open pattern
// `openLogAppendNoFollow` already established for ui.log (KEIKO-0886) -- a residual, documented
// TOCTOU window on that platform only.
function openPidFileNoFollow(path: string, flags: number): number {
  const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  if (nofollow === 0) assertNotSymlink(path);
  return openSync(path, flags | nofollow, 0o600);
}

// `fstatSync(fd).isFile()` is defense in depth beyond O_NOFOLLOW: O_NOFOLLOW only refuses a
// SYMLINK at the final component, not another non-regular target (FIFO, device) a state-dir actor
// could otherwise plant and have this block on, or read attacker-controlled bytes from.
function readPid(path: string): number | undefined {
  let fd: number;
  try {
    fd = openPidFileNoFollow(path, fsConstants.O_RDONLY);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_PID_FILE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!/^[1-9]\d*$/.test(raw)) return undefined;
    return Number(raw);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// Companion write path for the same descriptor-based invariant (`keiko start`'s writePid call
// site below): stages the write behind the identical O_NOFOLLOW-at-open / isFile() guard readPid
// uses, so neither direction of the pid file's lifecycle ever completes a check separately from
// the use it protects.
function writePid(path: string, pid: number): void {
  const fd = openPidFileNoFollow(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`keiko start: refusing to write to non-regular ${path}`);
    }
    writeSync(fd, `${String(pid)}\n`, null, "utf8");
  } finally {
    closeSync(fd);
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

// ESRCH-safe kill. `process.kill` throws ESRCH when the target has already exited; for a stop/cleanup
// kill that is the intended end state, not a failure. Swallowing it prevents `keiko start` from
// crashing with an opaque `Error: kill ESRCH` when the UI child exits on its own before the SIGTERM
// lands (observed on Windows: the crash masked the real "UI did not become healthy" report).
export const safeKillProcess: ProcessKiller = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
};

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

// #2478 (ADR-0141 W1.5): `keiko start` is the trusted launcher of the UI process. It provisions a
// process-scoped pairing secret to the spawned BFF as an inherited environment value only — never
// a disk file, never a URL — and, with `--open`, hands the browser one single-use, freshness-bounded
// pairing attestation in the boot URL fragment. An operator-provisioned secret in the caller's
// environment is respected so external supervision setups keep working.
function resolveLauncherPairingSecret(env: EnvSource): string {
  const provisioned = env[CODING_APP_SESSION_LAUNCHER_SECRET_ENV];
  if (
    typeof provisioned === "string" &&
    provisioned.length >= CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS
  ) {
    return provisioned;
  }
  return randomBytes(32).toString("hex");
}

// Dynamic import: the claim construction stays single-source in keiko-server without re-introducing
// the eager server module graph into every `keiko` invocation (GEN-PERF-CLI-001).
async function pairedOpenUrl(baseUrl: string, pairingSecret: string): Promise<string> {
  const { mintLauncherPairingAttestation } = await import("@oscharko-dev/keiko-server");
  const attestation = mintLauncherPairingAttestation({
    secret: pairingSecret,
    requestId: `req_launcher-${randomUUID()}`,
    issuedAtMs: Date.now(),
  });
  return `${baseUrl}/${encodeCodingAppSessionPairingFragment(attestation)}`;
}

function childEnv(env: EnvSource): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!Object.hasOwn(env, key) && value !== undefined) {
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

function cliEntryPath(cwd: string, env: EnvSource): string {
  const preferredLayout = resolvePreferredInstallLayout(cwd);
  if (preferredLayout !== undefined) return preferredLayout.binPath;
  // The root bin entry (`dist/cli/index.js`) surfaces `KEIKO_CLI_BIN_PATH` so
  // re-exec'd children spawned by `keiko start` invoke the published bin rather
  // than the cli package barrel (which is not executable). Route through
  // `absoluteExistingPath` — the same validation `install-layout.ts` applies to
  // this variable — so a relative or non-existent value is refused instead of
  // spawned (#KEIKO-0285). Read from the caller-supplied EnvSource only; the
  // parameter itself defaults to `process.env` at the call site, so no per-key
  // `?? process.env.X` fallback here — a test that passes `{}` must be able to
  // suppress an ambient KEIKO_CLI_BIN_PATH (KEIKO-0553).
  const fromEnv = absoluteExistingPath(env.KEIKO_CLI_BIN_PATH);
  if (fromEnv !== undefined) return fromEnv;
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

/**
 * Resolve the platform opener for an external URL without routing it through a shell parser.
 * `cmd /c start` percent-expands its argument, which corrupts a percent-encoded pairing fragment
 * (#2478), so on Windows the URL travels only inside a Base64-encoded PowerShell command — no
 * cmd.exe interpolation ever sees it.
 */
export function resolveExternalOpener(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    const command = `Start-Process '${url.replaceAll("'", "''")}'`;
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
    };
  }
  return { command: "xdg-open", args: [url] };
}

function defaultOpenExternal(url: string): void {
  const opener = resolveExternalOpener(url);
  const child = spawn(opener.command, [...opener.args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function maybeOpenBrowser(
  options: LifecycleOptions,
  io: CliIo,
  openExternal: (url: string) => void,
  pairingSecret?: string,
): Promise<void> {
  if (!options.openBrowser) return;
  const baseUrl = lifecycleBaseUrl(options);
  try {
    const target =
      pairingSecret === undefined ? baseUrl : await pairedOpenUrl(baseUrl, pairingSecret);
    openExternal(target);
  } catch {
    io.err(`keiko start: failed to open ${baseUrl} in the default browser.\n`);
  }
}

async function reportHealthyStart(
  options: LifecycleOptions,
  io: CliIo,
  pid: number,
  logPath: string,
  openExternal: (url: string) => void,
  pairingSecret: string,
): Promise<number> {
  io.out(`Keiko UI running on ${lifecycleBaseUrl(options)} (pid ${String(pid)}).\n`);
  io.out(`Logs: ${logPath}\n`);
  await maybeOpenBrowser(options, io, openExternal, pairingSecret);
  return 0;
}

// KEIKO-0886: refuse to follow a symlink at `<stateDir>/ui.log`. The launcher state file
// insists on O_NOFOLLOW at every open; the append-mode ui.log write in the same state dir
// used to accept a symlinked target, letting a state-dir actor steer stdout/stderr into
// any user-writable file. Match launcher-state.ts's O_NOFOLLOW pattern: read the flag
// defensively (undefined on Windows), and on Windows fall back to an lstat refusal since
// NTFS reparse points cannot be blocked at open time in a single syscall.
function openLogAppendNoFollow(logPath: string): number {
  const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  if (nofollow === 0) {
    assertNotSymlink(logPath);
  }
  return openSync(
    logPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | nofollow,
    0o600,
  );
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`keiko start: refusing to write to symlinked ${path}`);
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return; // path does not exist yet — nothing to follow
    }
    throw error;
  }
}

function openUiLogStdio(options: LifecycleOptions): UiLogStdio {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const logPath = logFile(options);
  const stdoutFd = openLogAppendNoFollow(logPath);
  try {
    const stderrLogFd = openLogAppendNoFollow(logPath);
    return {
      logPath,
      stdio: ["ignore", stdoutFd, stderrLogFd],
      close: (): void => {
        closeSync(stdoutFd);
        closeSync(stderrLogFd);
      },
    };
  } catch (error) {
    closeSync(stdoutFd);
    throw error;
  }
}

function spawnUiProcess(
  options: LifecycleOptions,
  env: EnvSource,
  deps: Pick<LifecycleRuntimeDeps, "spawnFn">,
  cwd: string,
  pairingSecret: string,
): { readonly child: ChildProcess; readonly logPath: string } {
  const logStdio = openUiLogStdio(options);
  const preferredLayout = resolvePreferredInstallLayout(cwd);
  const uiEnv = childEnv({
    ...env,
    KEIKO_STATE_DIR: options.stateDir,
    // ADR-0141 D2 / #2478: the launcher-provisioned pairing secret travels only through the
    // inherited environment of the spawned BFF.
    [CODING_APP_SESSION_LAUNCHER_SECRET_ENV]: pairingSecret,
    ...(preferredLayout === undefined
      ? {}
      : {
          KEIKO_CLI_BIN_PATH: preferredLayout.binPath,
          KEIKO_UI_STATIC_ROOT: preferredLayout.staticRoot,
        }),
  });
  try {
    return {
      child: deps.spawnFn(
        process.execPath,
        [cliEntryPath(cwd, env), "ui", "--port", String(options.port), "--host", options.host],
        {
          argv0: KEIKO_PROCESS_TITLE,
          cwd,
          detached: true,
          env: uiEnv,
          stdio: logStdio.stdio,
        },
      ),
      logPath: logStdio.logPath,
    };
  } finally {
    logStdio.close();
  }
}

async function waitForHealth(
  options: LifecycleOptions,
  pid: number,
  deps: Pick<LifecycleRuntimeDeps, "healthProbe" | "sleep" | "isProcessAlive">,
): Promise<boolean> {
  // Monotonic clock so a wall-clock adjustment during startup does not skip the health
  // window (forward jump) or hold it open indefinitely (backward jump).
  const start = performance.now();
  while (performance.now() - start <= options.startTimeoutMs) {
    if (!deps.isProcessAlive(pid)) return false;
    const health = await deps.healthProbe(healthUrl(options));
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

async function keepAlreadyRunningUi(
  options: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
  pid: number,
): Promise<void> {
  io.out(`Keiko UI already running on ${lifecycleBaseUrl(options)} (pid ${String(pid)}).\n`);
  // The pairing secret of an already-running BFF is process-private to that launch, so this
  // window opens unpaired (fail closed) — question content needs a fresh paired launch.
  await maybeOpenBrowser(options, io, deps.openExternal);
  if (options.openBrowser) {
    io.out(
      "Note: this window is not paired for coding question content; run `keiko restart --open` to pair a fresh app session.\n",
    );
  }
}

async function handleStaleRunning(
  options: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
  running: number,
): Promise<number | "start"> {
  const health = await deps.healthProbe(healthUrl(options));
  if (health.version === SDK_VERSION) {
    await keepAlreadyRunningUi(options, io, deps, running);
    return 0;
  }
  io.out(
    `Keiko UI process is stale (${staleProcessReason(health)}); restarting pid ${String(running)}.\n`,
  );
  const stopped = await cmdStop(options, io, deps);
  if (stopped !== 0) return stopped;
  return "start";
}

async function reportUnhealthyStart(
  options: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
  pid: number,
  logPath: string,
): Promise<number> {
  // #KEIKO-0437: escalate SIGTERM -> SIGKILL and only remove the pid file once the
  // process is confirmed gone. If it survives SIGKILL, KEEP the pid file so `keiko
  // stop` can still find and finish the orphan (never orphan the port silently).
  const outcome = await terminateAndConfirm(pid, options, deps);
  if (outcome.confirmed) {
    rmSync(pidFile(options), { force: true });
    io.err(`keiko start: UI did not become healthy. Logs: ${logPath}\n`);
  } else {
    io.err(
      `keiko start: UI did not become healthy and did not exit under SIGKILL (pid ${String(pid)} kept in ${pidFile(options)}). Logs: ${logPath}\n`,
    );
  }
  return 1;
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
    const nextAction = await handleStaleRunning(options, io, deps, running);
    if (nextAction !== "start") return nextAction;
  }

  if (!(await ensureStartPortAvailable(options, io, deps))) return 1;

  const pairingSecret = resolveLauncherPairingSecret(env);
  let spawned: { readonly child: ChildProcess; readonly logPath: string };
  try {
    spawned = spawnUiProcess(options, env, deps, cwd, pairingSecret);
  } catch {
    io.err("keiko start: failed to spawn the UI process.\n");
    return 1;
  }
  const { child, logPath } = spawned;

  // A detached spawn can fail ASYNCHRONOUSLY after returning (EMFILE, exec
  // permission revoked, …). With no listener Node throws the 'error' event and
  // crashes `keiko start` with a raw stack; with this listener the failure is
  // surfaced cleanly and the health poll below reports the failed start.
  child.once("error", (error: Error) => {
    io.err(`keiko start: UI process failed to launch (${error.message}).\n`);
  });

  if (child.pid === undefined) {
    io.err("keiko start: failed to spawn the UI process.\n");
    return 1;
  }
  child.unref();
  // KEIKO-0886 / #2906 review (comment 3863185744): refuse to write to a symlinked
  // <stateDir>/ui.pid so a hostile state-dir actor cannot re-point the pid file (which
  // process.kill reads) at any user-writable path outside home. writePid opens with O_NOFOLLOW so
  // the refusal check and the write are one syscall, not a separate lstat followed by a write.
  writePid(pidFile(options), child.pid);
  io.out(`Starting Keiko UI on ${lifecycleBaseUrl(options)} ...\n`);

  const healthy = await waitForHealth(options, child.pid, deps);
  if (healthy) {
    return reportHealthyStart(options, io, child.pid, logPath, deps.openExternal, pairingSecret);
  }

  return reportUnhealthyStart(options, io, deps, child.pid, logPath);
}

interface TerminateAndConfirmResult {
  readonly confirmed: boolean;
  readonly escalated: boolean;
}

// Shared teardown used by both cmdStop and the cmdStart unhealthy branch (#KEIKO-0437).
// Sends SIGTERM, polls isProcessAlive up to options.stopTimeoutMs, escalates to SIGKILL
// if still alive, then re-polls a short bounded window. The pid-file lifecycle is
// intentionally NOT touched here — the caller decides based on `confirmed`: remove the
// pid file only when the process is confirmed gone, keep it otherwise so `keiko stop`
// can still find and finish the orphan. `escalated` tells the caller whether the
// graceful window expired so cmdStop can emit its "sending SIGKILL" line at the same
// moment the SIGKILL is actually sent.
async function terminateAndConfirm(
  pid: number,
  options: LifecycleOptions,
  deps: Pick<LifecycleRuntimeDeps, "sleep" | "isProcessAlive" | "killProcess">,
  onEscalate?: () => void,
): Promise<TerminateAndConfirmResult> {
  deps.killProcess(pid, "SIGTERM");
  // PR-review follow-up (Codex thread 3771011316): measure elapsed shutdown time with the
  // monotonic performance.now() clock instead of Date.now(). A wall-clock adjustment
  // during shutdown (manual change, NTP correction) would otherwise extend the wait on a
  // backward jump and send SIGKILL prematurely on a forward jump — both independent of
  // the child process actually terminating.
  const gracefulStart = performance.now();
  while (performance.now() - gracefulStart <= options.stopTimeoutMs) {
    if (!deps.isProcessAlive(pid)) return { confirmed: true, escalated: false };
    await deps.sleep(500);
  }
  onEscalate?.();
  deps.killProcess(pid, "SIGKILL");
  // PR-review follow-up on KEIKO-0437: give SIGKILL its OWN bounded polling window instead of
  // whatever budget the graceful sleep left behind. Process termination + reap after SIGKILL
  // are asynchronous, and process.kill(pid, 0) can still succeed briefly; a zero-budget
  // remainder made the caller falsely conclude SIGKILL failed and retain ui.pid even when
  // the process exited moments later.
  const killStart = performance.now();
  while (performance.now() - killStart <= 2_000) {
    if (!deps.isProcessAlive(pid)) return { confirmed: true, escalated: true };
    await deps.sleep(100);
  }
  return { confirmed: !deps.isProcessAlive(pid), escalated: true };
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
  const outcome = await terminateAndConfirm(pid, options, deps, () => {
    io.err("keiko stop: UI did not exit gracefully; sending SIGKILL.\n");
  });
  if (!outcome.confirmed) {
    io.err(`keiko stop: failed to stop pid ${String(pid)}.\n`);
    return 1;
  }
  rmSync(pidFile(options), { force: true });
  io.out(outcome.escalated ? "Keiko UI stopped (forced).\n" : "Keiko UI stopped.\n");
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
  const fetchImpl = deps.fetchImpl;
  return {
    spawnFn: deps.spawnFn ?? spawn,
    healthProbe:
      fetchImpl === undefined
        ? defaultHealthProbe
        : (url: string): Promise<HealthProbeResult> => fetchHealthProbe(url, fetchImpl),
    sleep:
      deps.sleep ??
      ((ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    killProcess: deps.killProcess ?? safeKillProcess,
    isPortAvailable: deps.isPortAvailable ?? defaultIsPortAvailable,
    openExternal: deps.openExternal ?? defaultOpenExternal,
  };
}

// Wraps parseLifecycleArgs with the LauncherError conversion required by #KEIKO-0330:
// a STATE_DIR_ESCAPE surfaced inside `resolveContainedStateDir` becomes a clean stderr
// line plus non-zero exit ("refuse" sentinel), never an uncaught throw from the CLI.
type ParseOutcome =
  | { readonly kind: "options"; readonly value: LifecycleOptions }
  | { readonly kind: "help" }
  | { readonly kind: "usage" }
  | { readonly kind: "refuse"; readonly message: string };

function parseWithStateDirGuard(
  args: readonly string[],
  cwd: string,
  env: EnvSource,
  home: string,
): ParseOutcome {
  let parsed: LifecycleOptions | "help" | null;
  try {
    parsed = parseLifecycleArgs(args, cwd, env, home);
  } catch (e) {
    if (e instanceof LauncherError) return { kind: "refuse", message: `${e.message}\n` };
    throw e;
  }
  if (parsed === "help") return { kind: "help" };
  if (parsed === null) return { kind: "usage" };
  return { kind: "options", value: parsed };
}

export async function runLifecycleCli(
  command: LifecycleCommand,
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: LifecycleCliDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const home = (deps.homedir ?? defaultHomedir)();
  const outcome = parseWithStateDirGuard(args, cwd, env, home);
  if (outcome.kind === "help") {
    io.out(USAGE);
    return 0;
  }
  if (outcome.kind === "usage") {
    io.err(USAGE);
    return 2;
  }
  if (outcome.kind === "refuse") {
    io.err(outcome.message);
    return 1;
  }

  const options = outcome.value;
  const fullDeps = runtimeDeps(deps);

  const handlers: Readonly<Record<LifecycleCommand, () => Promise<number>>> = {
    start: () => cmdStart(options, io, env, fullDeps, cwd),
    stop: () => cmdStop(options, io, fullDeps),
    status: () => Promise.resolve(cmdStatus(options, io, fullDeps.isProcessAlive)),
    restart: () => cmdRestart(options, io, env, fullDeps, cwd),
  };
  return handlers[command]();
}
