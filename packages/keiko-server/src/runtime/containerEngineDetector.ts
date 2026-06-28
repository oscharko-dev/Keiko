// Issue #1388 (Epic #1491, ADR-0070, D1) — opt-in ACTIVE container engine probe. Distinct from the
// #1385 metadata-only detector (capabilityDetector.ts), which stays passive on the hot path; this
// module is invoked ONLY on explicit request (GET /api/containers/capability) and actively runs
// `docker version` / `docker info` (and the podman equivalents) THROUGH the single governed
// runCommand spawn boundary (deny-by-default CONTAINER_TASK_RULES, no shell, name-allowlisted env +
// ephemeral HOME, byte-capped + redacted output, timeout SIGTERM→SIGKILL). The host CLI process uses
// network:"inherit" because it must reach the local daemon socket.
//
// NEVER THROWS: every outcome — including a probe timeout (probe-timed-out) or an unparseable
// response (probe-failed) — is a structured ContainerEngineStatus. The KEIKO_CONTAINERS_DISABLED
// kill-switch short-circuits every engine to policy-blocked WITHOUT spawning.

import {
  CommandDeniedError,
  CommandTimeoutError,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  CONTAINER_ENGINE_IDS,
  CONTAINER_RUNTIME_SCHEMA_VERSION,
  CONTAINER_TASK_RULES,
  type ContainerCapabilityResponse,
  type ContainerEngineId,
  type ContainerEngineState,
  type ContainerEngineStatus,
  type ContainerEngineUnavailableReason,
} from "@oscharko-dev/keiko-contracts";

export const DEFAULT_CONTAINER_PROBE_DEADLINE_MS = 4_000 as const; // generous: real daemon round-trip
export const SUPPORTED_DOCKER_MAJOR = 20 as const; // engine-version floor; below → "unsupported"
const PER_CALL_TIMEOUT_MS = 2_000; // per `version`/`info` call; the overall deadline bounds both
export const KEIKO_CONTAINERS_DISABLED_ENV = "KEIKO_CONTAINERS_DISABLED" as const;

// runCommand needs a workspace for cwd containment; the probe never mounts anything, so a minimal
// host-level descriptor is sufficient. The container surface is host-level (capability is not
// project-scoped), so the detector accepts an optional workspace and synthesizes a stub otherwise.
function hostWorkspace(workspace: WorkspaceInfo | undefined): WorkspaceInfo {
  if (workspace !== undefined) {
    return workspace;
  }
  return {
    root: process.cwd(),
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

export interface ContainerProbeDeps {
  // Injectable spawn-boundary seam (tests pass a fake returning canned CommandResult / errors).
  readonly runCommand: typeof runCommand;
  readonly workspace?: WorkspaceInfo | undefined;
  readonly policy?: SandboxPolicy | undefined; // network:"inherit" (the CLI reaches the daemon)
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly deadlineMs?: number | undefined;
  readonly engines?: readonly ContainerEngineId[] | undefined;
}

interface EngineResolution {
  readonly state: ContainerEngineState;
  readonly version?: string | undefined;
  readonly unavailableReason?: ContainerEngineUnavailableReason | undefined;
}

// Static remediation catalog (D1): a fixed string per state, NEVER raw engine/OS error text.
const REMEDIATION_HINTS: Readonly<Record<ContainerEngineState, string | undefined>> = {
  available: undefined,
  missing: "Install the container engine or make it available on PATH.",
  "not-running": "Start Docker Desktop or the container daemon.",
  "permission-denied": "Grant your user access to the container socket (e.g. the docker group).",
  unsupported: "Upgrade the container engine to a supported version.",
  "policy-blocked": "Container execution is disabled by policy on this host.",
};

function disabledByKillSwitch(processEnv: NodeJS.ProcessEnv): boolean {
  const raw = processEnv[KEIKO_CONTAINERS_DISABLED_ENV];
  return typeof raw === "string" && raw.length > 0;
}

// Parses the leading integer of a `version --format {{.Server.Version}}` line. A value like
// "24.0.7" → 24. Returns undefined when no leading integer is present (unparseable → probe-failed).
function parseMajorVersion(raw: string): number | undefined {
  const match = /^\s*v?(\d+)\b/.exec(raw);
  if (match === null) {
    return undefined;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(major) ? major : undefined;
}

function isNotFoundDenial(error: CommandDeniedError): boolean {
  // runCommand throws CommandDeniedError with "not found on PATH" for a missing binary; any other
  // denial is a policy decision (allowlist/cwd), surfaced as policy-blocked.
  return error.message.includes("not found on PATH");
}

const DAEMON_DOWN_SIGNATURES = [
  "cannot connect to the docker daemon",
  "is the docker daemon running",
  "connect: connection refused",
  "error during connect",
  "cannot connect to podman",
  "no such file or directory", // socket path absent
];

const PERMISSION_SIGNATURES = ["permission denied", "eacces", "got permission denied"];

function matchesSignature(haystack: string, signatures: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return signatures.some((needle) => lower.includes(needle));
}

// Maps a settled (resolved) `version` CommandResult to an engine resolution. exitCode 0 with a
// parseable in-range version continues to the daemon-liveness `info` step; everything else is a
// structured unavailable state per the D1 table.
function resolveFromVersionResult(result: CommandResult): EngineResolution {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    if (matchesSignature(combined, PERMISSION_SIGNATURES)) {
      return { state: "permission-denied", unavailableReason: "executable-not-runnable" };
    }
    return { state: "not-running", unavailableReason: "daemon-not-running" };
  }
  const major = parseMajorVersion(result.stdout);
  if (major === undefined) {
    return { state: "unsupported", unavailableReason: "probe-failed" };
  }
  if (major < SUPPORTED_DOCKER_MAJOR) {
    return {
      state: "unsupported",
      version: result.stdout.trim(),
      unavailableReason: "unsupported-version",
    };
  }
  return { state: "available", version: result.stdout.trim() };
}

// Maps a thrown error from the `version` call. CommandTimeoutError → probe-timed-out (state stays
// "missing" so an unreachable engine never reads as available); a not-found denial → missing; any
// other denial → policy-blocked.
function resolveFromVersionError(error: unknown): EngineResolution {
  if (error instanceof CommandTimeoutError) {
    return { state: "missing", unavailableReason: "probe-timed-out" };
  }
  if (error instanceof CommandDeniedError) {
    return isNotFoundDenial(error)
      ? { state: "missing", unavailableReason: "executable-not-found" }
      : { state: "policy-blocked", unavailableReason: "policy-blocked" };
  }
  return { state: "unsupported", unavailableReason: "probe-failed" };
}

function buildProbeDeps(deps: ContainerProbeDeps): RunCommandDeps {
  const policy = deps.policy ?? DEFAULT_SANDBOX_POLICY;
  return {
    workspace: hostWorkspace(deps.workspace),
    // network:"inherit" — the host CLI process must reach the local daemon socket (D4). The CONTAINER
    // is isolated by --network none at run time; detection runs only `version`/`info`.
    policy: { ...policy, network: "inherit" },
    commandRules: CONTAINER_TASK_RULES,
    spawn: nodeSpawnFn,
    processEnv: deps.processEnv,
    now: deps.now,
  };
}

// Confirms daemon liveness via `info`. A clean exit keeps "available"; a non-zero exit or a daemon-
// down signature downgrades to not-running; an error is mapped like the version error.
async function confirmDaemon(
  engine: ContainerEngineId,
  runDeps: RunCommandDeps,
  run: typeof runCommand,
  signal: AbortSignal,
  base: EngineResolution,
): Promise<EngineResolution> {
  try {
    const result = await run(
      {
        command: engine,
        args: ["info", "--format", "{{.ServerErrors}}"],
        cwd: undefined,
        timeoutMs: PER_CALL_TIMEOUT_MS,
        signal,
      },
      runDeps,
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || matchesSignature(combined, DAEMON_DOWN_SIGNATURES)) {
      return { state: "not-running", unavailableReason: "daemon-not-running" };
    }
    return base;
  } catch (error) {
    if (error instanceof CommandTimeoutError) {
      return { state: "not-running", unavailableReason: "probe-timed-out" };
    }
    return { state: "not-running", unavailableReason: "daemon-not-running" };
  }
}

async function probeEngine(
  engine: ContainerEngineId,
  deps: ContainerProbeDeps,
  runDeps: RunCommandDeps,
): Promise<EngineResolution> {
  const controller = new AbortController();
  let versionResolution: EngineResolution;
  try {
    const result = await deps.runCommand(
      {
        command: engine,
        args: ["version", "--format", "{{.Server.Version}}"],
        cwd: undefined,
        timeoutMs: PER_CALL_TIMEOUT_MS,
        signal: controller.signal,
      },
      runDeps,
    );
    versionResolution = resolveFromVersionResult(result);
  } catch (error) {
    return resolveFromVersionError(error);
  }
  if (versionResolution.state !== "available") {
    return versionResolution;
  }
  return confirmDaemon(engine, runDeps, deps.runCommand, controller.signal, versionResolution);
}

function statusFromResolution(
  engine: ContainerEngineId,
  resolution: EngineResolution,
): ContainerEngineStatus {
  const hint = REMEDIATION_HINTS[resolution.state];
  return {
    engine,
    state: resolution.state,
    ...(resolution.version === undefined ? {} : { version: resolution.version }),
    ...(resolution.unavailableReason === undefined
      ? {}
      : { unavailableReason: resolution.unavailableReason }),
    ...(hint === undefined ? {} : { remediationHint: hint }),
  };
}

function killSwitchStatus(engine: ContainerEngineId): ContainerEngineStatus {
  return {
    engine,
    state: "policy-blocked",
    unavailableReason: "policy-blocked",
    remediationHint: REMEDIATION_HINTS["policy-blocked"],
  };
}

// Active container-engine probe (D1). NEVER throws; returns a structured ContainerCapabilityResponse.
export async function detectContainerEngines(
  deps: ContainerProbeDeps,
): Promise<ContainerCapabilityResponse> {
  const generatedAtMs = deps.now();
  const deadlineMs = deps.deadlineMs ?? DEFAULT_CONTAINER_PROBE_DEADLINE_MS;
  const engines = deps.engines ?? CONTAINER_ENGINE_IDS;
  // Kill-switch: short-circuit EVERY engine to policy-blocked with NO spawn (assert in tests).
  if (disabledByKillSwitch(deps.processEnv)) {
    return {
      schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
      generatedAtMs,
      deadlineMs,
      engines: engines.map((engine) => killSwitchStatus(engine)),
      anyAvailable: false,
    };
  }
  const runDeps = buildProbeDeps(deps);
  const statuses: ContainerEngineStatus[] = [];
  for (const engine of engines) {
    const resolution = await probeEngine(engine, deps, runDeps);
    statuses.push(statusFromResolution(engine, resolution));
  }
  return {
    schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
    generatedAtMs,
    deadlineMs,
    engines: statuses,
    anyAvailable: statuses.some((status) => status.state === "available"),
  };
}
