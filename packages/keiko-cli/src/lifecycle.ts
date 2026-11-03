import { mkdirSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { get as httpGet } from "node:http";
import { homedir as defaultHomedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { isProcessAlive } from "@oscharko-dev/keiko-security/process-scope";
import {
  resolveWindowsPowerShellExecutable,
  securityErrorKind,
  bindSecurityLogCorrelation,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
import {
  isActivityLogReadinessSnapshot,
  type ActivityLogReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
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
import {
  absoluteExistingPath,
  resolvePreferredInstallLayout,
  installLayoutOverrideEvidence,
  writeInstallLayoutOverrideEvidence,
} from "./install-layout.js";
import { LauncherError } from "./launcher-platforms.js";
import { resolveLoopbackEndpoint } from "./loopback-endpoint.js";
import { emitBrowserHandoff } from "./lifecycle-browser-activity.js";
import { emitLifecycleHealth } from "./lifecycle-health-activity.js";
import { emitNativeUiOwnership } from "./lifecycle-native-activity.js";
import {
  nativeUiGenerationReaped,
  nativeUiGenerationOwned,
  nativeUiAttemptSettled,
  nativeUiLaunchIdUnused,
} from "./native-ui-reap.js";
import { withUiLifecycleGuard } from "./ui-lifecycle-guard.js";
import {
  resolveManagedNativeUiRuntime,
  startNativeUiProcess,
  type NativeUiRuntime,
  type NativeUiLaunch,
  NativeUiAdmissionError,
} from "./native-ui-runtime.js";
import { isKeikoUiLaunchId } from "@oscharko-dev/keiko-contracts/runtime/ui-launch";
import type { CliIo } from "./runner.js";
import {
  createCliSecurityLogSink,
  emitCliWindowsSystemFailure,
  type CliSecurityLogSinkFactory,
} from "./security-log.js";
import {
  KEIKO_UI_LAUNCH_ID_ENV,
  UI_LAUNCH_ID_FLAG,
  readPidRecord,
  readUiLifecycleTracking,
  writePendingUiLaunch,
  removePendingUiLaunch,
  removeStaleShutdownRequest,
  removePidFileIfMatches,
  resolveContainedStateDir,
  writeExclusivePidFile,
  writeBrowserOpenRequest,
  type PidRecord,
} from "./state-paths.js";
import {
  defaultReadProcessCommandLine,
  liveIdentityTextHasLaunchId,
  liveProcessHasLaunchId,
} from "./ui-process-identity.js";
import { terminateUiProcess, type WindowsTreeKill } from "./ui-process-stop.js";

type LifecycleCommand = "start" | "stop" | "status" | "restart";
type SpawnFn = (command: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type HealthProbeFn = (url: string, timeoutMs?: number) => Promise<HealthProbeResult>;
type SleepFn = (ms: number) => Promise<void>;
type ProcessKiller = (pid: number, signal?: NodeJS.Signals | 0) => void;
type BrowserOpener = (url: string) => void | Promise<void>;
type PortAvailabilityFn = (host: string, port: number) => Promise<boolean>;
type LifecycleFlag = "--port" | "--host" | "--state-dir" | "--start-timeout" | "--stop-timeout";
type LifecycleFlagSetter = (raw: RawLifecycleOptions, value: string) => void;

const KEIKO_PROCESS_TITLE = "Keiko";
const PORTABLE_RECOVERED_LAUNCH_ENV = "KEIKO_PORTABLE_RECOVERED_LAUNCH";
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

function decodeRecoveredLaunch(encoded: string): unknown {
  if (encoded.length < 1 || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new TypeError("invalid recovered launch identity");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded)
    throw new TypeError("invalid recovered launch identity");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function recoveredLaunchId(encoded: string | undefined): string {
  if (encoded === undefined) return randomBytes(16).toString("hex");
  const decoded = decodeRecoveredLaunch(encoded);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError("invalid recovered launch identity");
  }
  const launchId = (decoded as Record<string, unknown>).launchId;
  if (!isKeikoUiLaunchId(launchId)) {
    throw new TypeError("invalid recovered launch identity");
  }
  return launchId;
}

function launchIdForStart(env: EnvSource, io: CliIo): string | undefined {
  try {
    return recoveredLaunchId(env[PORTABLE_RECOVERED_LAUNCH_ENV]);
  } catch {
    io.err("keiko start: recovered portable launch identity is invalid.\n");
    return undefined;
  }
}

const USAGE = `Usage:
  keiko start [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH] [--open|--no-open]
  keiko stop [--state-dir PATH]
  keiko restart [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH] [--open|--no-open]
  keiko status [--port PORT] [--host 127.0.0.1|localhost] [--state-dir PATH]

Manages the local Keiko UI process. Runtime state is written to .keiko/ by default.
Start and restart open an authenticated browser session by default; --no-open opts out.
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
  readonly nativeUiRuntime?: NativeUiRuntime | undefined;
  readonly cwd?: string | undefined;
  readonly homedir?: (() => string) | undefined;
  readonly spawnFn?: SpawnFn | undefined;
  readonly fetchImpl?: FetchFn | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
  readonly killProcess?: ProcessKiller | undefined;
  readonly isPortAvailable?: PortAvailabilityFn | undefined;
  readonly openExternal?: BrowserOpener | undefined;
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly killWindowsTree?: WindowsTreeKill | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly securityLogSinkFactory?: CliSecurityLogSinkFactory | undefined;
  readonly verifyLaunchIdentity?: ((pid: number, launchId: string) => boolean) | undefined;
  /** Test seam: the process command line the tracked UI's own endpoint is read from. */
  readonly readCommandLine?: ((pid: number) => string | undefined) | undefined;
}

interface LifecycleRuntimeDeps {
  readonly nativeUiRuntime?: NativeUiRuntime | undefined;
  readonly home: string;
  readonly correlationId: string;
  readonly spawnFn: SpawnFn;
  readonly healthProbe: HealthProbeFn;
  readonly sleep: SleepFn;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly killProcess: ProcessKiller;
  readonly isPortAvailable: PortAvailabilityFn;
  readonly openExternal: BrowserOpener;
  readonly platform: NodeJS.Platform;
  readonly killWindowsTree?: WindowsTreeKill | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly verifyLaunchIdentity?: ((pid: number, launchId: string) => boolean) | undefined;
  readonly readCommandLine?: ((pid: number) => string | undefined) | undefined;
}

interface HealthProbeResult {
  readonly reachable: boolean;
  readonly version: string | undefined;
  readonly launchId?: string | undefined;
  // The server's diagnostic readiness (#3532), when the health body carried a valid block.
  readonly diagnostics?: ActivityLogReadinessSnapshot | undefined;
}

const HEALTH_PROBE_TIMEOUT_MS = 1_000;
const HEALTH_RESPONSE_MAX_BYTES = 64 * 1024;

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
  const milliseconds = Number(raw) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
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
    if (arg === "--open" || arg === "--no-open") {
      raw.openBrowser = arg === "--open";
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
    openBrowser: raw.openBrowser !== false,
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

// Where the UI process's evidence lives. The detached UI child no longer persists its raw
// stdout/stderr (#3532): every diagnostic it produces is a body-free Activity Log line, so the
// operator is pointed at the Activity Log and the support commands that read it.
function activityLogDirectory(options: LifecycleOptions): string {
  return join(options.stateDir, "logs");
}

function activityLogHint(options: LifecycleOptions): string {
  return `Activity Log: ${activityLogDirectory(options)} (read it with \`keiko support export\` and \`keiko support analyze\`)`;
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

// The `diagnostics` block is untrusted input like the rest of the body: admitted only when it
// passes the closed contract guard, otherwise reported as unknown.
function healthDiagnostics(payload: unknown): ActivityLogReadinessSnapshot | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const diagnostics = (payload as { readonly diagnostics?: unknown }).diagnostics;
  return isActivityLogReadinessSnapshot(diagnostics) ? diagnostics : undefined;
}

function healthResult(statusCode: number | undefined, body: string): HealthProbeResult {
  if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
    return { reachable: false, version: undefined };
  }
  try {
    const payload = JSON.parse(body) as unknown;
    const launchId: unknown =
      typeof payload === "object" && payload !== null
        ? Reflect.get(payload, "launchId")
        : undefined;
    return {
      reachable: true,
      version: healthVersion(payload),
      diagnostics: healthDiagnostics(payload),
      ...(isKeikoUiLaunchId(launchId) ? { launchId } : {}),
    };
  } catch {
    return { reachable: true, version: undefined };
  }
}

function defaultHealthProbe(
  url: string,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<HealthProbeResult> {
  return new Promise((resolveProbe) => {
    const request = httpGet(url, { signal: AbortSignal.timeout(timeoutMs) }, (response) => {
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
    request.once("error", () => {
      resolveProbe({ reachable: false, version: undefined });
    });
  });
}

async function fetchHealthProbe(
  url: string,
  fetchImpl: FetchFn,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<HealthProbeResult> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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
  return isProcessAlive(pid);
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
  sink?: SecurityLogSink,
): ReturnType<typeof readPidRecord> {
  const path = pidFile(options);
  const record = trackedUiRecord(options, path, sink);
  if (record === undefined) return undefined;
  if (!isAlive(record.pid)) {
    if (record.nativeAppRuntime && !nativeUiGenerationReaped(options.stateDir, record))
      return record;
    rmSync(path, { force: true });
    if (record.nativeAppRuntime) emitNativeUiOwnership(sink, "cleanup", "reaped");
    return undefined;
  }
  return record;
}

class UiLifecycleTrackingError extends Error {
  constructor(options?: ErrorOptions) {
    super("UI lifecycle tracking remains uncertain", options);
    this.name = "UiLifecycleTrackingError";
  }
}

function lifecycleTracking(path: string): ReturnType<typeof readUiLifecycleTracking> {
  try {
    return readUiLifecycleTracking(path);
  } catch (error) {
    throw new UiLifecycleTrackingError({ cause: error });
  }
}

function trackedUiRecord(
  options: LifecycleOptions,
  path: string,
  sink?: SecurityLogSink,
): PidRecord | undefined {
  const tracking = lifecycleTracking(path);
  if (tracking.kind === "process") return tracking.record;
  if (tracking.kind === "absent") return undefined;
  if (tracking.kind === "starting" && nativeUiAttemptSettled(options.stateDir, tracking.launchId)) {
    removePendingUiLaunch(path, tracking.launchId);
    emitNativeUiOwnership(sink, "cleanup", "acknowledged");
    return undefined;
  }
  throw new UiLifecycleTrackingError();
}

function runningPid(
  options: LifecycleOptions,
  isAlive: (pid: number) => boolean,
  sink?: SecurityLogSink,
): number | undefined {
  return runningPidRecord(options, isAlive, sink)?.pid;
}

// #2478 (ADR-0141 W1.5): `keiko start` is the trusted launcher of the UI process. It provisions a
// process-scoped pairing secret to the spawned BFF as an inherited environment value only — never
// a disk file, never a URL — and, unless `--no-open`, hands the browser one single-use, freshness-bounded
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

const BROWSER_OPENER_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "LOCALAPPDATA",
  "APPDATA",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "KDE_FULL_SESSION",
  "BROWSER",
  "LANG",
  "LC_ALL",
] as const;

function waitForExternalOpener(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(code === 0 && signal === null ? undefined : new Error("Browser opener failed"));
    };
    const timer = setTimeout(() => {
      finish(new Error("Browser opener result timed out"));
    }, 5_000);
    child.once("error", onError);
    child.once("close", onClose);
    child.once("spawn", () => {
      child.unref();
    });
  });
}

export async function defaultOpenExternal(
  url: string,
  platform: NodeJS.Platform,
  env: EnvSource,
): Promise<void> {
  const { buildSandboxEnv } = await import("@oscharko-dev/keiko-tools");
  const opener = resolveExternalOpener(url, platform, env);
  const child = spawn(opener.command, [...opener.args], {
    detached: true,
    stdio: "ignore",
    env: buildSandboxEnv(env, BROWSER_OPENER_ENVIRONMENT),
  });
  await waitForExternalOpener(child);
}

async function maybeOpenBrowser(
  options: LifecycleOptions,
  io: CliIo,
  openExternal: BrowserOpener,
  securityLogSink: SecurityLogSink | undefined,
  pairingSecret?: string,
): Promise<void> {
  if (!options.openBrowser) {
    emitBrowserHandoff(securityLogSink, { outcome: "headless", attestationProvided: false });
    return;
  }
  await performBrowserHandoff(
    lifecycleBaseUrl(options),
    io,
    openExternal,
    securityLogSink,
    pairingSecret,
  );
}

export async function performBrowserHandoff(
  baseUrl: string,
  io: CliIo,
  openExternal: BrowserOpener,
  securityLogSink: SecurityLogSink | undefined,
  pairingSecret?: string,
): Promise<void> {
  try {
    const target =
      pairingSecret === undefined ? baseUrl : await pairedOpenUrl(baseUrl, pairingSecret);
    await openExternal(target);
    emitBrowserHandoff(securityLogSink, {
      outcome: "requested",
      attestationProvided: pairingSecret !== undefined,
    });
  } catch (error) {
    emitBrowserHandoff(securityLogSink, {
      outcome: "failed",
      attestationProvided: pairingSecret !== undefined,
      error,
    });
    emitCliWindowsSystemFailure(error, securityLogSink, "start-open-browser");
    io.err(`keiko start: failed to open ${baseUrl} in the default browser.\n`);
  }
}

async function reportHealthyStart(
  options: LifecycleOptions,
  io: CliIo,
  pid: number,
  openExternal: BrowserOpener,
  securityLogSink: SecurityLogSink | undefined,
  pairingSecret: string,
): Promise<number> {
  io.out(`Keiko UI running on ${lifecycleBaseUrl(options)} (pid ${String(pid)}).\n`);
  io.out(`${activityLogHint(options)}\n`);
  await maybeOpenBrowser(options, io, openExternal, securityLogSink, pairingSecret);
  return 0;
}

// #3532: the detached UI child's stdio is ignored. It used to be appended, raw and unbounded, to
// `<stateDir>/ui.log` — free text that included error messages and could never be made body-free.
// Every diagnostic the child produces now reaches the Activity Log as a registered line, and a
// startup failure surfaces as the child's `process.fatal` line plus this command's closed start
// result. The state directory is still created here, owner-only, because the pid file below is
// published into it before the child has run.
function spawnUiProcess(
  options: LifecycleOptions,
  env: EnvSource,
  deps: Pick<LifecycleRuntimeDeps, "spawnFn">,
  cwd: string,
  pairingSecret: string,
  launchId: string,
): ChildProcess {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  return deps.spawnFn(process.execPath, uiProcessArguments(options, cwd, env, launchId), {
    argv0: KEIKO_PROCESS_TITLE,
    cwd,
    detached: true,
    env: uiProcessEnvironment(options, env, cwd, pairingSecret, launchId),
    stdio: "ignore",
  });
}

function uiProcessEnvironment(
  options: LifecycleOptions,
  env: EnvSource,
  cwd: string,
  pairingSecret: string,
  launchId: string,
): NodeJS.ProcessEnv {
  const preferredLayout = resolvePreferredInstallLayout(cwd);
  return childEnv({
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
}

function uiProcessArguments(
  options: LifecycleOptions,
  cwd: string,
  env: EnvSource,
  launchId: string,
): readonly string[] {
  return [
    cliEntryPath(cwd, env),
    "ui",
    "--port",
    String(options.port),
    "--host",
    options.host,
    UI_LAUNCH_ID_FLAG,
    launchId,
  ];
}

// The closed start result a failed `keiko start` reports (#3532): the child exited before it
// became healthy, or it stayed alive without answering the health check in time.
type StartOutcome = "healthy" | "process-exited" | "health-timeout";

async function waitForHealth(
  options: LifecycleOptions,
  pid: number,
  launchId: string,
  deps: Pick<LifecycleRuntimeDeps, "healthProbe" | "sleep" | "isProcessAlive">,
  deadline = performance.now() + options.startTimeoutMs,
): Promise<StartOutcome> {
  // Monotonic clock so a wall-clock adjustment during startup does not skip the health
  // window (forward jump) or hold it open indefinitely (backward jump).
  while (performance.now() < deadline) {
    if (!deps.isProcessAlive(pid)) return "process-exited";
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) break;
    const health = await deps.healthProbe(
      healthUrl(options),
      Math.min(HEALTH_PROBE_TIMEOUT_MS, remaining),
    );
    if (
      health.version === SDK_VERSION &&
      health.launchId === launchId &&
      deps.isProcessAlive(pid) &&
      performance.now() < deadline
    ) {
      return "healthy";
    }
    await deps.sleep(Math.min(500, Math.max(0, deadline - performance.now())));
  }
  return "health-timeout";
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

function keepAlreadyRunningUi(
  options: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
  record: PidRecord,
): boolean {
  io.out(`Keiko UI already running on ${lifecycleBaseUrl(options)} (pid ${String(record.pid)}).\n`);
  if (!options.openBrowser) {
    emitBrowserHandoff(deps.securityLogSink, { outcome: "headless", attestationProvided: false });
    return true;
  }
  if (record.launchId === undefined) {
    io.out("Run `keiko restart` to open an authenticated browser for this older launch.\n");
    emitBrowserHandoff(deps.securityLogSink, {
      outcome: "restart-required",
      attestationProvided: false,
      reason: "launch-id-missing",
    });
    return true;
  }
  if (record.browserOpenSupported !== true) {
    io.out("Run `keiko restart` to open an authenticated browser for this older launch.\n");
    emitBrowserHandoff(deps.securityLogSink, {
      outcome: "restart-required",
      attestationProvided: false,
      reason: "channel-unsupported",
    });
    return true;
  }
  try {
    writeBrowserOpenRequest(
      options.stateDir,
      record.pid,
      record.launchId,
      deps.correlationId,
      options.host === "localhost" ? "localhost" : "127.0.0.1",
    );
  } catch (error) {
    emitBrowserHandoff(deps.securityLogSink, {
      outcome: "failed",
      attestationProvided: false,
      error,
    });
    io.err("keiko start: failed to request a browser from the running UI.\n");
    return false;
  }
  emitBrowserHandoff(deps.securityLogSink, { outcome: "delegated", attestationProvided: false });
  return true;
}

// The pid file records no port, but the tracked UI was spawned as `ui --port N --host H
// --keiko-launch-id ID` (`uiProcessArguments`). Its live command line is therefore the record's own
// endpoint, read only when it also carries the record's launch id so another process cannot
// supply it. Anything else falls back to the requested endpoint.
const LOOPBACK_UI_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

function commandLineFlagValue(commandLine: string, flag: string): string | undefined {
  const tokens = commandLine.split(/[\s\0]+/u);
  const index = tokens.indexOf(flag);
  return index === -1 ? undefined : tokens[index + 1];
}

function commandLineEndpoint(
  commandLine: string,
): { readonly host: string; readonly port: number } | undefined {
  const rawPort = commandLineFlagValue(commandLine, "--port");
  const host = commandLineFlagValue(commandLine, "--host");
  if (rawPort === undefined || !/^\d{1,5}$/u.test(rawPort)) return undefined;
  const port = Number(rawPort);
  if (port < 1 || port > 65_535) return undefined;
  return host !== undefined && LOOPBACK_UI_HOSTS.has(host) ? { host, port } : undefined;
}

function trackedEndpointOptions(
  options: LifecycleOptions,
  deps: LifecycleRuntimeDeps,
  record: PidRecord,
): LifecycleOptions {
  if (record.launchId === undefined) return options;
  const read =
    deps.readCommandLine ??
    ((pid: number): string | undefined => defaultReadProcessCommandLine(pid, deps.platform));
  const commandLine = read(record.pid);
  if (commandLine === undefined || !liveIdentityTextHasLaunchId(commandLine, record.launchId)) {
    return options;
  }
  const endpoint = commandLineEndpoint(commandLine);
  return endpoint === undefined ? options : { ...options, ...endpoint };
}

async function handleStaleRunning(
  requested: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
  running: PidRecord,
): Promise<number | "start"> {
  // Health, the "already running" report and the browser handoff address the tracked instance's
  // own endpoint, never the port this invocation asked for (L1).
  const options = trackedEndpointOptions(requested, deps, running);
  const health = await deps.healthProbe(healthUrl(options));
  if (
    !trackedUiStillOwned(options, deps, running) ||
    healthConflictsWithTracked(health, running.launchId)
  ) {
    emitLifecycleHealth(deps.securityLogSink, "tracked", "identity-mismatch", false);
    io.err(
      "keiko start: health did not confirm the tracked launch identity; ownership is retained.\n",
    );
    return 1;
  }
  if (health.version === SDK_VERSION) {
    emitLifecycleHealth(deps.securityLogSink, "tracked", "healthy", running.launchId !== undefined);
    return keepAlreadyRunningUi(options, io, deps, running) ? 0 : 1;
  }
  io.out(
    `Keiko UI process is stale (${staleProcessReason(health)}); restarting pid ${String(running.pid)}.\n`,
  );
  const stopped = await cmdStop(options, io, deps);
  if (stopped !== 0) return stopped;
  return "start";
}

function trackedUiStillOwned(
  options: LifecycleOptions,
  deps: LifecycleRuntimeDeps,
  record: PidRecord,
): boolean {
  const current = readPidRecord(pidFile(options), record.nativeAppRuntime === true);
  if (!sameTrackedUiRecord(current, record) || !deps.isProcessAlive(record.pid)) {
    return false;
  }
  const verify = deps.verifyLaunchIdentity ?? liveProcessHasLaunchId;
  if (record.launchId !== undefined && !verify(record.pid, record.launchId)) return false;
  return record.nativeAppRuntime !== true || nativeUiGenerationOwned(options.stateDir, record);
}

function sameTrackedUiRecord(current: PidRecord | undefined, expected: PidRecord): boolean {
  return (
    current?.pid === expected.pid &&
    current.launchId === expected.launchId &&
    current.browserOpenSupported === expected.browserOpenSupported &&
    current.nativeAppRuntime === expected.nativeAppRuntime
  );
}

function healthConflictsWithTracked(
  health: HealthProbeResult,
  launchId: string | undefined,
): boolean {
  if (launchId === undefined || !health.reachable) return false;
  if (health.launchId !== undefined) return health.launchId !== launchId;
  // Older servers did not emit launchId. Their confirmed owned process may still be restarted;
  // only the current version's health can authorize retaining a modern launch as healthy.
  return health.version === SDK_VERSION;
}

async function reportUnhealthyStart(
  options: LifecycleOptions,
  io: CliIo,
  deps: LifecycleRuntimeDeps,
  pid: number,
  launchId: string,
  startOutcome: Exclude<StartOutcome, "healthy">,
): Promise<number> {
  // #KEIKO-0437: escalate graceful stop -> forced stop and only remove the pid file once the
  // process is confirmed gone. If it survives forced termination, KEEP the pid file so `keiko
  // stop` can still find and finish the orphan (never orphan the port silently).
  const outcome = await terminateAndConfirm(pid, options, deps, undefined, launchId);
  if (outcome.confirmed) {
    removePidFileIfMatches(pidFile(options), pid, launchId);
    io.err(
      `keiko start: UI did not become healthy (${startOutcome}). ${activityLogHint(options)}\n`,
    );
  } else {
    io.err(
      `keiko start: UI did not become healthy (${startOutcome}) and did not exit under ${forcedStopLabel(deps.platform)} (pid ${String(pid)} kept in ${pidFile(options)}). ${activityLogHint(options)}\n`,
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
    writeExclusivePidFile(pidFile(options), pid, launchId, true);
    return true;
  } catch (error) {
    deps.killProcess(pid, "SIGKILL");
    // The content-free class only: a filesystem error's text carries the path it failed on.
    io.err(`keiko start: failed to publish the UI process pid (${securityErrorKind(error)}).\n`);
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
  const running = runningPidRecord(options, deps.isProcessAlive, deps.securityLogSink);
  if (running !== undefined) {
    const nextAction = await handleStaleRunning(options, io, deps, running);
    if (nextAction !== "start") return nextAction;
  }

  if (!(await ensureStartPortAvailable(options, io, deps))) return 1;
  if (!clearStaleShutdownRequest(options.stateDir, io)) return 1;

  const pairingSecret = resolveLauncherPairingSecret(env);
  const launchId = launchIdForStart(env, io);
  if (launchId === undefined) return 1;
  let native: NativeUiRuntime | undefined;
  try {
    native =
      deps.nativeUiRuntime ??
      (await resolveManagedNativeUiRuntime(options.stateDir, env, deps.home, deps.platform));
  } catch {
    emitNativeUiOwnership(deps.securityLogSink, "admission", "refused");
    io.err("keiko start: installed native runtime could not be verified.\n");
    return 1;
  }
  if (native !== undefined)
    return startOwnedUi({ options, io, env, deps, cwd, pairingSecret, launchId }, native);
  return startDirectUi({ options, io, env, deps, cwd, pairingSecret, launchId });
}

async function startDirectUi(context: OwnedUiStartContext): Promise<number> {
  const { options, io, env, deps, cwd, pairingSecret, launchId } = context;
  let child: ChildProcess;
  try {
    child = spawnUiProcess(options, env, deps, cwd, pairingSecret, launchId);
  } catch {
    emitLifecycleHealth(deps.securityLogSink, "start", "spawn-refused", false);
    io.err("keiko start: failed to spawn the UI process.\n");
    return 1;
  }

  // A detached spawn can fail ASYNCHRONOUSLY after returning (EMFILE, exec
  // permission revoked, …). With no listener Node throws the 'error' event and
  // crashes `keiko start` with a raw stack; with this listener the failure is
  // surfaced cleanly — by its content-free class, never its path-bearing message — and the
  // health poll below reports the failed start.
  child.once("error", (error: Error) => {
    io.err(`keiko start: UI process failed to launch (${securityErrorKind(error)}).\n`);
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

  const startOutcome = await waitForHealth(options, child.pid, launchId, deps);
  emitLifecycleHealth(deps.securityLogSink, "start", startOutcome, startOutcome === "healthy");
  if (startOutcome === "healthy") {
    return reportHealthyStart(
      options,
      io,
      child.pid,
      deps.openExternal,
      deps.securityLogSink,
      pairingSecret,
    );
  }

  return reportUnhealthyStart(options, io, deps, child.pid, launchId, startOutcome);
}

interface OwnedUiStartContext {
  readonly options: LifecycleOptions;
  readonly io: CliIo;
  readonly env: EnvSource;
  readonly deps: LifecycleRuntimeDeps;
  readonly cwd: string;
  readonly pairingSecret: string;
  readonly launchId: string;
}

async function publishOwnedUiPid(
  context: OwnedUiStartContext,
  launch: NativeUiLaunch,
): Promise<boolean> {
  try {
    writeExclusivePidFile(pidFile(context.options), launch.pid, context.launchId, true, true);
    const record = readPidRecord(pidFile(context.options), true);
    if (
      record?.pid !== launch.pid ||
      record.launchId !== context.launchId ||
      !record.nativeAppRuntime
    )
      throw new Error("native-ui-pid-publication-unverified");
    return true;
  } catch {
    await launch.abort();
    emitNativeUiOwnership(
      context.deps.securityLogSink,
      "cleanup",
      nativeUiGenerationReaped(context.options.stateDir, {
        pid: launch.pid,
        launchId: context.launchId,
      })
        ? "reaped"
        : "held",
    );
    context.io.err("keiko start: failed to publish native UI ownership.\n");
    return false;
  }
}

async function commitOwnedUi(
  context: OwnedUiStartContext,
  launch: NativeUiLaunch,
  deadline: number,
): Promise<number> {
  try {
    await launch.commit();
    if (performance.now() >= deadline) throw new Error("native-ui-commit-expired");
  } catch {
    launch.release();
    emitNativeUiOwnership(context.deps.securityLogSink, "commit", "uncertain");
    context.io.err(
      "keiko start: native ownership confirmation is unavailable; tracking retained.\n",
    );
    return 1;
  }
  launch.release();
  emitNativeUiOwnership(context.deps.securityLogSink, "commit", "acknowledged");
  return reportHealthyStart(
    context.options,
    context.io,
    launch.pid,
    context.deps.openExternal,
    context.deps.securityLogSink,
    context.pairingSecret,
  );
}

function reportOwnedAdmissionFailure(context: OwnedUiStartContext, error: unknown): number {
  const { options, deps, launchId, io } = context;
  const settled =
    (error instanceof NativeUiAdmissionError && !error.nativeAuthorityMayBeLive) ||
    nativeUiAttemptSettled(options.stateDir, launchId);
  if (settled) removePendingUiLaunch(pidFile(options), launchId);
  emitNativeUiOwnership(deps.securityLogSink, "admission", settled ? "refused" : "uncertain");
  io.err(
    "keiko start: native UI ownership could not be established. Uncertain starts remain tracked.\n",
  );
  return 1;
}

async function startOwnedUi(
  context: OwnedUiStartContext,
  runtime: NativeUiRuntime,
): Promise<number> {
  const { options, io, env, deps, cwd, pairingSecret, launchId } = context;
  const deadline = performance.now() + options.startTimeoutMs;
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  let launch: NativeUiLaunch;
  try {
    launch = await startNativeUiProcess({
      runtime,
      args: [runtime.cliBinPath, ...uiProcessArguments(options, cwd, env, launchId).slice(1)],
      cwd,
      env: {
        ...uiProcessEnvironment(options, env, cwd, pairingSecret, launchId),
        KEIKO_CLI_BIN_PATH: runtime.cliBinPath,
        KEIKO_UI_STATIC_ROOT: runtime.staticRoot,
      },
      launchId,
      startTimeoutMs: options.startTimeoutMs,
      deadline,
      reserve: (): void => {
        if (!nativeUiLaunchIdUnused(options.stateDir, launchId))
          throw new Error("Native launch identity was already used");
        writePendingUiLaunch(pidFile(options), launchId);
      },
      spawnFn: deps.spawnFn,
    });
  } catch (error) {
    return reportOwnedAdmissionFailure(context, error);
  }

  emitNativeUiOwnership(deps.securityLogSink, "admission", "acknowledged");
  if (!(await publishOwnedUiPid(context, launch))) return 1;
  io.out(`Starting Keiko UI on ${lifecycleBaseUrl(options)} ...\n`);
  const outcome = await waitForHealth(options, launch.pid, launchId, deps, deadline);
  emitLifecycleHealth(deps.securityLogSink, "start", outcome, outcome === "healthy");
  if (outcome === "healthy") return commitOwnedUi(context, launch, deadline);
  await launch.abort();
  return reportUnhealthyStart(options, io, deps, launch.pid, launchId, outcome);
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
  const record = runningPidRecord(options, deps.isProcessAlive, deps.securityLogSink);
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

// `keiko status` also reports the running server's diagnostic readiness (#3532), read from the
// closed `diagnostics` block of its health endpoint. A server that does not answer, or answers
// without a valid block, is reported as `unknown` rather than guessed.
function readinessStatusLine(health: HealthProbeResult): string {
  const diagnostics = health.diagnostics;
  if (diagnostics === undefined)
    return "Diagnostic evidence: unknown (health check unavailable).\n";
  const reasons = diagnostics.reasons.length === 0 ? "" : ` (${diagnostics.reasons.join(", ")})`;
  return `Diagnostic evidence: ${diagnostics.readiness}${reasons}; lost events: ${String(diagnostics.lostEvents)}.\n`;
}

async function cmdStatus(
  options: LifecycleOptions,
  io: CliIo,
  deps: Pick<LifecycleRuntimeDeps, "healthProbe" | "isProcessAlive" | "securityLogSink">,
): Promise<number> {
  const pid = runningPid(options, deps.isProcessAlive, deps.securityLogSink);
  if (pid === undefined) {
    io.out("Keiko UI is not running.\n");
    return 0;
  }
  io.out(`Keiko UI is running on ${lifecycleBaseUrl(options)} (pid ${String(pid)}).\n`);
  io.out(readinessStatusLine(await deps.healthProbe(healthUrl(options))));
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

function lifecycleHome(deps: LifecycleCliDeps): string {
  return (deps.homedir ?? defaultHomedir)();
}

function runtimeDeps(
  deps: LifecycleCliDeps,
  env: EnvSource,
  securityLogSink: SecurityLogSink | undefined,
  correlationId: string,
): LifecycleRuntimeDeps {
  const fetchImpl = deps.fetchImpl;
  const platform = deps.platform?.() ?? process.platform;
  return {
    nativeUiRuntime: deps.nativeUiRuntime,
    home: lifecycleHome(deps),
    correlationId,
    spawnFn: deps.spawnFn ?? spawn,
    healthProbe:
      fetchImpl === undefined
        ? defaultHealthProbe
        : (url: string, timeoutMs?: number): Promise<HealthProbeResult> =>
            fetchHealthProbe(url, fetchImpl, timeoutMs),
    sleep:
      deps.sleep ??
      ((ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    killProcess: deps.killProcess ?? safeKillProcess,
    isPortAvailable: deps.isPortAvailable ?? defaultIsPortAvailable,
    openExternal:
      deps.openExternal ??
      ((url: string): Promise<void> => defaultOpenExternal(url, platform, env)),
    platform,
    killWindowsTree: deps.killWindowsTree,
    processEnv: deps.processEnv,
    securityLogSink,
    verifyLaunchIdentity: deps.verifyLaunchIdentity,
    readCommandLine: deps.readCommandLine,
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

function lifecycleInvocationCorrelationId(env: EnvSource): string {
  return installLayoutOverrideEvidence(env)?.correlationId ?? randomUUID();
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
  const correlationId = lifecycleInvocationCorrelationId(env);
  writeInstallLayoutOverrideEvidence(deps.securityLogSinkFactory?.(options.stateDir), env);
  const securityLogSink =
    bindSecurityLogCorrelation(deps.securityLogSink, correlationId) ??
    createCliSecurityLogSink(options.stateDir, deps.securityLogSinkFactory, correlationId);
  const fullDeps = runtimeDeps(deps, env, securityLogSink, correlationId);

  const handlers: Readonly<Record<LifecycleCommand, () => Promise<number>>> = {
    start: () => cmdStart(options, io, env, fullDeps, cwd),
    stop: () => cmdStop(options, io, fullDeps),
    status: () => cmdStatus(options, io, fullDeps),
    restart: () => cmdRestart(options, io, env, fullDeps, cwd),
  };
  return guardedLifecycleInvocation(
    command,
    options.stateDir,
    io,
    securityLogSink,
    handlers[command],
    home,
  );
}

async function guardedLifecycleInvocation(
  command: LifecycleCommand,
  stateDir: string,
  io: CliIo,
  securityLogSink: SecurityLogSink | undefined,
  operation: () => Promise<number>,
  home: string,
): Promise<number> {
  try {
    const result = await withUiLifecycleGuard(stateDir, command !== "status", operation, home);
    if (result.kind === "complete") return result.value;
  } catch (error) {
    const reason =
      error instanceof UiLifecycleTrackingError
        ? "UI lifecycle ownership remains uncertain"
        : `UI lifecycle operation failed (${securityErrorKind(error)})`;
    io.err(`keiko: ${reason}; tracking retained.\n`);
    emitNativeUiOwnership(securityLogSink, "reservation", "held", error);
    return 1;
  }
  io.err("keiko: another UI lifecycle operation is still in progress.\n");
  emitNativeUiOwnership(securityLogSink, "reservation", "held");
  return 1;
}
