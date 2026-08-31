import { closeSync, constants as fsConstants, mkdirSync, openSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { get as httpGet } from "node:http";
import { homedir as defaultHomedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  resolveWindowsPowerShellExecutable,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
// From the contracts leaf, NOT keiko-server or the keiko-sdk fat barrel: pulling the server
// module graph in eagerly here cost every `keiko` invocation ~410ms of ESM loading
// (GEN-PERF-CLI-001). Lifecycle needs the loopback endpoint constants plus the launcher half of
// the ADR-0141 app-session pairing hand-off (#2478); the claim-minting keiko-server import stays
// dynamic inside the `--open` path.
import {
  CODING_APP_SESSION_LAUNCHER_SECRET_ENV,
  CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS,
  encodeCodingAppSessionPairingFragment,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { KEIKO_PRODUCT_VERSION as SDK_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import { absoluteExistingPath, resolvePreferredInstallLayout } from "./install-layout.js";
import { LauncherError } from "./launcher-platforms.js";
import { resolveLoopbackEndpoint } from "./loopback-endpoint.js";
import type { CliIo } from "./runner.js";
import {
  createCliSecurityLogSink,
  emitCliWindowsSystemFailure,
  type CliSecurityLogSinkFactory,
} from "./security-log.js";
import {
  KEIKO_UI_LAUNCH_ID_ENV,
  assertNotSymlink,
  assertRegularSingleLinkFile,
  readPidRecord,
  removeStaleShutdownRequest,
  removePidFileIfMatches,
  resolveContainedStateDir,
  writeExclusivePidFile,
} from "./state-paths.js";
import { terminateUiProcess, type WindowsTreeKill } from "./ui-process-stop.js";

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
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly killWindowsTree?: WindowsTreeKill | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly securityLogSinkFactory?: CliSecurityLogSinkFactory | undefined;
  readonly verifyLaunchIdentity?: ((pid: number, launchId: string) => boolean) | undefined;
}

interface LifecycleRuntimeDeps {
  readonly spawnFn: SpawnFn;
  readonly healthProbe: HealthProbeFn;
  readonly sleep: SleepFn;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly killProcess: ProcessKiller;
  readonly isPortAvailable: PortAvailabilityFn;
  readonly openExternal: (url: string) => void;
  readonly platform: NodeJS.Platform;
  readonly killWindowsTree?: WindowsTreeKill | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly verifyLaunchIdentity?: ((pid: number, launchId: string) => boolean) | undefined;
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

// KEIKO-0886 follow-up (#2906 round 3, comment 3865273699): the descriptor-safe pid-file
// invariant (O_NOFOLLOW+O_NONBLOCK at open, then fstat-verified regular-single-link-file before
// trusting the content — full rationale in state-paths.ts's doc comment on `readPidFile`) used
// to be duplicated here as a private `readPid`, while `state-paths.ts::readPidFile` — reached by
// `classifyPid`, and therefore by `keiko uninstall --force` and `keiko repair` too — still
// followed plain `existsSync`/`readFileSync`. A symlinked `ui.pid` could steer THOSE commands at
// an unrelated process even though `start`/`stop`/`status`/`restart` here were already hardened.
// `readPid` is gone; every reader in this file and every other consumer now goes through the
// ONE shared `readPidFile`. The write path uses `writeExclusivePidFile` from the same module
// (`ui.pid` here, `ui.shutdown` from `terminateUiProcess`) so both pid-shaped artifacts share
// the O_NOFOLLOW / regular-single-link exclusive-create guards.

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

function runningPidRecord(
  options: LifecycleOptions,
  isAlive: (pid: number) => boolean,
): ReturnType<typeof readPidRecord> {
  const path = pidFile(options);
  const record = readPidRecord(path);
  if (record === undefined) {
    rmSync(path, { force: true });
    return undefined;
  }
  if (!isAlive(record.pid)) {
    rmSync(path, { force: true });
    return undefined;
  }
  return record;
}

function runningPid(
  options: LifecycleOptions,
  isAlive: (pid: number) => boolean,
): number | undefined {
  return runningPidRecord(options, isAlive)?.pid;
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
  env: EnvSource = process.env,
): { readonly command: string; readonly args: readonly string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    const command = `Start-Process '${url.replaceAll("'", "''")}'`;
    return {
      command: resolveWindowsPowerShellExecutable(env),
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

function defaultOpenExternal(url: string, platform: NodeJS.Platform, env: EnvSource): void {
  const opener = resolveExternalOpener(url, platform, env);
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
  securityLogSink: SecurityLogSink | undefined,
  pairingSecret?: string,
): Promise<void> {
  if (!options.openBrowser) return;
  const baseUrl = lifecycleBaseUrl(options);
  try {
    const target =
      pairingSecret === undefined ? baseUrl : await pairedOpenUrl(baseUrl, pairingSecret);
    openExternal(target);
  } catch (error) {
    emitCliWindowsSystemFailure(error, securityLogSink, "start-open-browser");
    io.err(`keiko start: failed to open ${baseUrl} in the default browser.\n`);
  }
}

async function reportHealthyStart(
  options: LifecycleOptions,
  io: CliIo,
  pid: number,
  logPath: string,
  openExternal: (url: string) => void,
  securityLogSink: SecurityLogSink | undefined,
  pairingSecret: string,
): Promise<number> {
  io.out(`Keiko UI running on ${lifecycleBaseUrl(options)} (pid ${String(pid)}).\n`);
  io.out(`Logs: ${logPath}\n`);
  await maybeOpenBrowser(options, io, openExternal, securityLogSink, pairingSecret);
  return 0;
}

// KEIKO-0886 / #2906 round 3 (comment 3865329050): refuse to write `<stateDir>/ui.log` through
// a symlink, hard link, FIFO, or device. O_NOFOLLOW alone only rejects a SYMLINK at the final
// path component — a HARD LINK to another user's file has no symlink component, so the syscall
// that blocks symlinks has nothing to object to, and would receive every byte of this process's
// child stdout/stderr. Worse, a FIFO planted at the path can block this open() (O_WRONLY)
// indefinitely waiting for a reader that never arrives, before any POST-open validation could
// ever run. Both are closed the same way the pid file already is (state-paths.ts):
//   * O_NONBLOCK on every platform that has it, so a planted FIFO can never hang the open()
//     call itself.
//   * the OPENED descriptor is fstat-verified via the shared `assertRegularSingleLinkFile`
//     (isFile() + nlink === 1) before it is ever handed to the child — the same
//     regular-single-link-file policy the pid file enforces, reused rather than re-derived.
// Windows has no O_NOFOLLOW; `assertNotSymlink` is the documented, residual-TOCTOU fallback for
// its reparse-point case, and the post-open fstat check below still runs unconditionally on
// every platform, including that fallback.
function openLogAppendNoFollow(logPath: string): number {
  const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonblock = (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  if (nofollow === 0) {
    assertNotSymlink(logPath);
  }
  const fd = openSync(
    logPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | nofollow | nonblock,
    0o600,
  );
  try {
    assertRegularSingleLinkFile(fd, logPath);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
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
  launchId: string,
): { readonly child: ChildProcess; readonly logPath: string } {
  const logStdio = openUiLogStdio(options);
  const preferredLayout = resolvePreferredInstallLayout(cwd);
  const uiEnv = childEnv({
    ...env,
    KEIKO_STATE_DIR: options.stateDir,
    [KEIKO_UI_LAUNCH_ID_ENV]: launchId,
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
  await maybeOpenBrowser(options, io, deps.openExternal, deps.securityLogSink);
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
  launchId: string,
): Promise<number> {
  // #KEIKO-0437: escalate graceful stop -> forced stop and only remove the pid file once the
  // process is confirmed gone. If it survives forced termination, KEEP the pid file so `keiko
  // stop` can still find and finish the orphan (never orphan the port silently).
  const outcome = await terminateAndConfirm(pid, options, deps, undefined, launchId);
  if (outcome.confirmed) {
    removePidFileIfMatches(pidFile(options), pid, launchId);
    io.err(`keiko start: UI did not become healthy. Logs: ${logPath}\n`);
  } else {
    io.err(
      `keiko start: UI did not become healthy and did not exit under ${forcedStopLabel(deps.platform)} (pid ${String(pid)} kept in ${pidFile(options)}). Logs: ${logPath}\n`,
    );
  }
  return 1;
}

// #2906 review (comment 3865159294): terminates the just-spawned child if pid publication fails,
// so a hostile state-dir actor who wins the exclusive-create race in `writeExclusivePidFile` (or any
// other publish failure) can never leave an unmanaged, unkillable-by-`keiko stop` child running.
// SIGKILL immediately rather than the graceful SIGTERM-then-escalate `terminateAndConfirm` uses
// elsewhere: the child was spawned moments ago and has not yet published a health endpoint, so
// there is nothing graceful to wait for and no pid file yet for a concurrent `keiko stop` to
// contend with.
function publishPidOrKillChild(
  options: LifecycleOptions,
  io: CliIo,
  deps: Pick<LifecycleRuntimeDeps, "killProcess">,
  pid: number,
  launchId: string,
): boolean {
  try {
    writeExclusivePidFile(pidFile(options), pid, launchId);
    return true;
  } catch (error) {
    deps.killProcess(pid, "SIGKILL");
    io.err(
      `keiko start: failed to publish the UI process pid (${error instanceof Error ? error.message : String(error)}).\n`,
    );
    return false;
  }
}

function clearStaleShutdownRequest(stateDir: string, io: CliIo): boolean {
  try {
    removeStaleShutdownRequest(stateDir);
    return true;
  } catch {
    io.err("keiko start: failed to clear a stale shutdown request.\n");
    return false;
  }
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
  if (!clearStaleShutdownRequest(options.stateDir, io)) return 1;

  const pairingSecret = resolveLauncherPairingSecret(env);
  const launchId = randomBytes(16).toString("hex");
  let spawned: { readonly child: ChildProcess; readonly logPath: string };
  try {
    spawned = spawnUiProcess(options, env, deps, cwd, pairingSecret, launchId);
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
  // KEIKO-0886 / #2906 review (comment 3863185744, then comment 3865159294): refuse to write to a
  // symlinked/hard-linked/FIFO <stateDir>/ui.pid so a hostile state-dir actor cannot re-point the
  // pid file (which process.kill reads) at any user-writable path outside home, or corrupt one.
  // writeExclusivePidFile's exclusive-create slot can still fail closed (e.g. an actor winning every
  // create-retry race) -- a spawned-but-unpublished child must never be left running headless
  // with no pid file `keiko stop` can find it by, so a publish failure kills the child immediately
  // and fails the command closed instead of leaking an unmanaged process.
  if (!publishPidOrKillChild(options, io, deps, child.pid, launchId)) return 1;
  io.out(`Starting Keiko UI on ${lifecycleBaseUrl(options)} ...\n`);

  const healthy = await waitForHealth(options, child.pid, deps);
  if (healthy) {
    return reportHealthyStart(
      options,
      io,
      child.pid,
      logPath,
      deps.openExternal,
      deps.securityLogSink,
      pairingSecret,
    );
  }

  return reportUnhealthyStart(options, io, deps, child.pid, logPath, launchId);
}

interface TerminateAndConfirmResult {
  readonly confirmed: boolean;
  readonly escalated: boolean;
}

function forcedStopLabel(platform: NodeJS.Platform): string {
  return platform === "win32" ? "process-tree termination" : "SIGKILL";
}

// Shared teardown used by both cmdStop and the cmdStart unhealthy branch (#KEIKO-0437, #3351).
// Requests graceful drain via `<stateDir>/ui.shutdown` (and SIGTERM on POSIX), polls
// isProcessAlive up to options.stopTimeoutMs, escalates to Windows tree-kill then SIGKILL
// if still alive, then re-polls a short bounded window. The pid-file lifecycle is
// intentionally NOT touched here — the caller decides based on `confirmed`: remove the
// pid file only when the process is confirmed gone, keep it otherwise so `keiko stop`
// can still find and finish the orphan. `escalated` tells the caller whether the
// graceful window expired so cmdStop can emit its forced-stop line at the same
// moment the escalation is actually sent.
async function terminateAndConfirm(
  pid: number,
  options: LifecycleOptions,
  deps: LifecycleRuntimeDeps,
  onEscalate?: () => void,
  launchId?: string,
): Promise<TerminateAndConfirmResult> {
  return terminateUiProcess({
    pid,
    stateDir: options.stateDir,
    stopTimeoutMs: options.stopTimeoutMs,
    platform: deps.platform,
    sleep: deps.sleep,
    isProcessAlive: deps.isProcessAlive,
    killProcess: deps.killProcess,
    killWindowsTree: deps.killWindowsTree,
    processEnv: deps.processEnv,
    securityLogSink: deps.securityLogSink,
    escalate: true,
    onEscalate,
    launchId,
    verifyLaunchIdentity: deps.verifyLaunchIdentity,
  });
}

async function cmdStop(
  options: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
): Promise<number> {
  const record = runningPidRecord(options, deps.isProcessAlive);
  if (record === undefined) {
    io.out("Keiko UI is not running.\n");
    return 0;
  }
  io.out(`Stopping Keiko UI (pid ${String(record.pid)}) ...\n`);
  const outcome = await terminateAndConfirm(
    record.pid,
    options,
    deps,
    () => {
      io.err(
        deps.platform === "win32"
          ? "keiko stop: UI did not exit gracefully; terminating the process tree.\n"
          : "keiko stop: UI did not exit gracefully; sending SIGKILL.\n",
      );
    },
    record.launchId,
  );
  if (!outcome.confirmed) {
    io.err(`keiko stop: failed to stop pid ${String(record.pid)}.\n`);
    return 1;
  }
  removePidFileIfMatches(pidFile(options), record.pid, record.launchId);
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

function runtimeDeps(
  deps: LifecycleCliDeps,
  env: EnvSource,
  securityLogSink: SecurityLogSink | undefined,
): LifecycleRuntimeDeps {
  const fetchImpl = deps.fetchImpl;
  const platform = deps.platform?.() ?? process.platform;
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
    openExternal:
      deps.openExternal ??
      ((url: string): void => {
        defaultOpenExternal(url, platform, env);
      }),
    platform,
    killWindowsTree: deps.killWindowsTree,
    processEnv: deps.processEnv,
    securityLogSink,
    verifyLaunchIdentity: deps.verifyLaunchIdentity,
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
  const securityLogSink =
    deps.securityLogSink ?? createCliSecurityLogSink(options.stateDir, deps.securityLogSinkFactory);
  const fullDeps = runtimeDeps(deps, env, securityLogSink);

  const handlers: Readonly<Record<LifecycleCommand, () => Promise<number>>> = {
    start: () => cmdStart(options, io, env, fullDeps, cwd),
    stop: () => cmdStop(options, io, fullDeps),
    status: () => Promise.resolve(cmdStatus(options, io, fullDeps.isProcessAlive)),
    restart: () => cmdRestart(options, io, env, fullDeps, cwd),
  };
  return handlers[command]();
}
