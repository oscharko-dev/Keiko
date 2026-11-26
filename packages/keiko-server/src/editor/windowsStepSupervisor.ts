// #4496 (ADR-0043 D21): the Windows execution-root backend of a governed verification run. The
// supervisor is the runtime's own, verified against the same pin that admits a Windows Coding run;
// each step gets a private copy written from those verified bytes. Without that supervisor the
// backend is absent and a step is refused as isolation unavailable, exactly as before. The
// runtime's patched Node.js (#4492) is verified here too; without a verified one the steps run as
// they did before and the log names it, so a project that needs no Node.js is unaffected.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  WindowsStepDrive,
  WindowsStepSupervisor,
  WindowsStepSupervisorCopy,
} from "@oscharko-dev/keiko-contracts";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { discoverDevLaneOpenCode } from "../coding-runtime/devLanePortableCodingRuntime.js";
import {
  discardVerifiedHelperCopy,
  verifiedHelperExecutionCopy,
} from "../coding-runtime/nativeRuntimeProcessBackend.js";
import {
  windowsGatewayHelperPin,
  type ResolvedPortableOpenCodeRuntime,
} from "../coding-runtime/productionOpenCodeBackend.js";
import { discoverQualifiedPortableOpenCode } from "../coding-runtime/productionPortableCodingRuntime.js";
import { CommandDeniedError } from "@oscharko-dev/keiko-security";
import { isCredentialNamedSegment } from "@oscharko-dev/keiko-workspace";
import { ISOLATION_UNAVAILABLE_DENIAL_PREFIX } from "@oscharko-dev/keiko-verification";
import type { NpmLaneStepNodeApproval } from "../coding-runtime/npmLaneRuntimeApprovals.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import {
  mapWindowsStepDrives,
  nodeWindowsDriveHost,
  unmapWindowsStepDrives,
  type WindowsDriveHost,
  type WindowsStepDriveScope,
} from "./windowsStepDrives.js";
import { resolveStepNode, windowsStepNodeFor, windowsStepNodePin } from "./windowsStepNode.js";

const WINDOWS_STEP_SUPERVISOR_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.verification.windows-step-supervisor",
  category: "process",
  owner: "keiko-server",
  emitter: "editor.windowsStepSupervisor.resolve",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["available", "no-runtime", "no-pin", "pin-mismatch"],
    },
    readRootCount: { type: "integer", dataClass: "count", required: true },
    // #4496: toolchain homes left out because they hold or sit in `.m2`, or hold a credential-named entry.
    readRootRefusedCount: { type: "integer", dataClass: "count", required: true },
    // #4492: whether a Maven step may read the person's repository; never its path.
    mavenRepository: { type: "boolean", dataClass: "closed-enum", required: true },
    // #4492: the runtime's patched Node.js. `absent` runs the steps as before, `mismatch` is a
    // build that is not the pinned one and is never offered.
    stepNode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["patched", "absent", "mismatch"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  // A missing supervisor is the backend's absence: the step is refused as isolation unavailable.
  failureClasses: ["runtime-confinement-unavailable"],
  proofIds: ["editor.verification.windows-step-supervisor.emitted-line"],
  releaseImpact: "patch",
});

// #4492: the supervisor's closed refusal code. Without it a refused step was only "denied", and a
// supervisor that could not take its per-user lock looked like a policy decision.
const WINDOWS_STEP_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.verification.windows-step-refused",
  category: "process",
  owner: "keiko-server",
  emitter: "editor.windowsStepSupervisor.refused",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["before-launch", "after-launch"],
    },
    refusalCode: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["runtime-confinement-unavailable"],
  proofIds: ["editor.verification.windows-step-refused.emitted-line"],
  releaseImpact: "patch",
});

/** The toolchain homes a step reads besides its executable's own folder: Java's and Maven's. */
const READ_ROOT_VARIABLES = ["JAVA_HOME", "MAVEN_HOME", "M2_HOME"] as const;

// A drive path, as the supervisor accepts a grant: `X:\...`, never a relative or rooted one.
const DRIVE_PATH = /^[A-Za-z]:\\/u;

function directoryOf(value: string | undefined): string | undefined {
  if (value === undefined || !DRIVE_PATH.test(value) || !existsSync(value)) return undefined;
  return statSync(value).isDirectory() ? win32.normalize(value) : undefined;
}

/** What the read-root check asks of the file system; injectable so tests need no Windows host. */
export interface WindowsReadRootHost {
  readonly directoryOf: (value: string | undefined) => string | undefined;
  /** The directory's entry names, or `undefined` when it cannot be listed. */
  readonly entryNames: (directory: string) => readonly string[] | undefined;
}

const NODE_READ_ROOT_HOST: WindowsReadRootHost = {
  directoryOf,
  entryNames: (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return undefined;
    }
  },
};

// Whether `child` is `parent` or lies inside it, with Windows' case-insensitive comparison.
function windowsPathContains(parent: string, child: string): boolean {
  const relative = win32.relative(parent, child);
  const leaves = relative === ".." || relative.startsWith("..\\");
  return !leaves && !win32.isAbsolute(relative);
}

// A home that holds or sits inside the profile's `.m2` would hand a read of its settings and their
// credentials to the step; `MAVEN_HOME\conf` (Maven's own global settings) stays readable.
function readRootIsRefused(
  root: string,
  profile: string | undefined,
  host: WindowsReadRootHost,
): boolean {
  if (profile !== undefined && DRIVE_PATH.test(profile)) {
    const m2 = win32.join(profile, ".m2");
    if (windowsPathContains(root, m2) || windowsPathContains(m2, root)) return true;
  }
  // A home that cannot be listed cannot be shown free of credentials, so it is refused.
  const names = host.entryNames(root);
  return names === undefined || names.some(isCredentialNamedSegment);
}

export function windowsStepReadRoots(
  env: NodeJS.ProcessEnv,
  host: WindowsReadRootHost = NODE_READ_ROOT_HOST,
): { readonly roots: readonly string[]; readonly refusedCount: number } {
  const homes = READ_ROOT_VARIABLES.map((name) => host.directoryOf(env[name])).filter(
    (root): root is string => root !== undefined,
  );
  const unique = [...new Set(homes)];
  const roots = unique.filter((root) => !readRootIsRefused(root, env.USERPROFILE, host));
  return { roots: Object.freeze(roots), refusedCount: unique.length - roots.length };
}

/**
 * Whether a path is a real directory: not a file, not a link or junction, and reached through no
 * linked parent, so the grant names the folder it reads.
 */
export function isRealDirectory(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink()) return false;
  return realpathSync.native(path).toLowerCase() === path.toLowerCase();
}

/**
 * The person's Maven repository (`%USERPROFILE%\.m2\repository`), which a Maven step reads
 * read-only and offline (#4492, ADR-0184); `.m2` itself, with its settings and their credentials,
 * is never granted.
 */
export function windowsMavenRepository(
  env: NodeJS.ProcessEnv,
  isDirectory: (path: string) => boolean = isRealDirectory,
): string | undefined {
  const profile = env.USERPROFILE;
  if (profile === undefined || !DRIVE_PATH.test(profile)) return undefined;
  const repository = win32.join(profile, ".m2", "repository");
  return isDirectory(repository) ? repository : undefined;
}

function discoveredRuntime(env: NodeJS.ProcessEnv): ResolvedPortableOpenCodeRuntime | undefined {
  const portable = discoverQualifiedPortableOpenCode({ env });
  if (portable !== undefined) return portable;
  const development = discoverDevLaneOpenCode({ env });
  return development.outcome === "activated" ? development.runtime : undefined;
}

export interface WindowsStepSupervisorInput {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly activityLog: ServerLogSink;
  readonly correlationId?: string | undefined;
  /** Injectable for tests; defaults to the installed or development runtime. */
  readonly runtime?: (() => ResolvedPortableOpenCodeRuntime | undefined) | undefined;
  /** Injectable for tests; defaults to the person's `.m2\repository` when it is a real folder. */
  readonly mavenRepository?: ((env: NodeJS.ProcessEnv) => string | undefined) | undefined;
  /** Injectable for tests; defaults to `subst.exe` in this logon session. */
  readonly driveHost?: WindowsDriveHost | undefined;
  /** Injectable for tests; defaults to the step Node.js pin compiled into this server. */
  readonly stepNodePin?: (() => NpmLaneStepNodeApproval | undefined) | undefined;
}

type SupervisorBinary =
  | { readonly outcome: "available"; readonly helperPath: string; readonly pin: string }
  | { readonly outcome: "no-runtime" | "no-pin" | "pin-mismatch" };

// Whether the installed bytes carry the pin now; each step's copy is verified again when written.
function matchesPin(helperPath: string, pin: string): boolean {
  if (!existsSync(helperPath)) return false;
  return createHash("sha256").update(readFileSync(helperPath)).digest("hex") === pin;
}

function supervisorBinary(runtime: ResolvedPortableOpenCodeRuntime | undefined): SupervisorBinary {
  const helperPath = runtime?.nativeHelperPath;
  if (runtime === undefined || helperPath === undefined) return { outcome: "no-runtime" };
  const pin = windowsGatewayHelperPin(runtime);
  if (pin === undefined) return { outcome: "no-pin" };
  return matchesPin(helperPath, pin)
    ? { outcome: "available", helperPath, pin }
    : { outcome: "pin-mismatch" };
}

// A copy that cannot be verified (its bytes miss the pin, or it cannot be written) is a supervisor
// that cannot be governed: the step is refused as isolation unavailable, the same closed reason as
// a host without a backend, and never run.
function verifiedCopy(
  helperPath: string,
  pin: string,
  correlationId: string | undefined,
): ReturnType<typeof verifiedHelperExecutionCopy> {
  try {
    return verifiedHelperExecutionCopy(helperPath, pin);
  } catch (error) {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "editor.verification.windows-step-supervisor.copy-refused",
        source: "editor.verification.windows-step-supervisor",
        error,
        redact: () => "The Windows step supervisor could not be verified against its pin.",
      }),
    );
    throw new CommandDeniedError(
      `${ISOLATION_UNAVAILABLE_DENIAL_PREFIX}the Windows step supervisor could not be verified against its pin`,
      "keiko-runtime-supervisor.exe",
    );
  }
}

function discardCopy(
  copy: ReturnType<typeof verifiedHelperExecutionCopy>,
  correlationId: string | undefined,
): void {
  void discardVerifiedHelperCopy(copy, {
    operation: "editor.verification.windows-step-supervisor.cleanup",
    source: "editor.verification.windows-step-supervisor",
    correlationId,
  });
}

/**
 * Each step's private copy, written from the verified bytes, with a drive letter for each of the
 * step's granted directories; both are removed when the step ends.
 */
function verifiedCopies(
  helperPath: string,
  pin: string,
  drives: WindowsStepDriveScope,
): WindowsStepSupervisor["acquire"] {
  return (grantedRoots): WindowsStepSupervisorCopy => {
    const copy = verifiedCopy(helperPath, pin, drives.correlationId);
    let mapped: readonly WindowsStepDrive[];
    try {
      mapped = mapWindowsStepDrives(grantedRoots, drives);
    } catch (error) {
      discardCopy(copy, drives.correlationId);
      throw error;
    }
    return {
      path: copy.path,
      drives: mapped,
      release: (): void => {
        unmapWindowsStepDrives(mapped, drives);
        discardCopy(copy, drives.correlationId);
      },
      refused: (code, launched): void => {
        drives.activityLog.write(
          activityLogEvent(
            WINDOWS_STEP_REFUSED_OPERATION,
            { correlationId: drives.correlationId ?? UNKNOWN_CORRELATION_ID },
            { phase: launched ? "after-launch" : "before-launch", refusalCode: code },
          ),
        );
      },
    };
  };
}

// The runtime's patched Node.js, looked for only beside a verified supervisor (#4492).
function verifiedStepNode(
  binary: SupervisorBinary,
  input: WindowsStepSupervisorInput,
): ReturnType<typeof resolveStepNode> {
  return resolveStepNode({
    supervisorPath: binary.outcome === "available" ? binary.helperPath : undefined,
    pin: (input.stepNodePin ?? windowsStepNodePin)(),
    isDirectory: isRealDirectory,
    correlationId: input.correlationId,
  });
}

/**
 * The supervisor a verification run's steps are framed to on Windows, or undefined on every other
 * platform and when no verified supervisor exists. Resolving it records the outcome.
 */
export function resolveWindowsStepSupervisor(
  input: WindowsStepSupervisorInput,
): WindowsStepSupervisor | undefined {
  if ((input.platform ?? process.platform) !== "win32") return undefined;
  const env = input.env ?? process.env;
  const binary = supervisorBinary(
    input.runtime === undefined ? discoveredRuntime(env) : input.runtime(),
  );
  const { roots: readRoots, refusedCount } = windowsStepReadRoots(env);
  const mavenRepository = (input.mavenRepository ?? windowsMavenRepository)(env);
  const stepNode = verifiedStepNode(binary, input);
  input.activityLog.write(
    activityLogEvent(
      WINDOWS_STEP_SUPERVISOR_OPERATION,
      { correlationId: input.correlationId ?? UNKNOWN_CORRELATION_ID },
      {
        outcome: binary.outcome,
        readRootCount: readRoots.length,
        readRootRefusedCount: refusedCount,
        mavenRepository: mavenRepository !== undefined,
        stepNode: stepNode.outcome,
      },
    ),
  );
  if (binary.outcome !== "available") return undefined;
  const drives: WindowsStepDriveScope = {
    host: input.driveHost ?? nodeWindowsDriveHost(env),
    activityLog: input.activityLog,
    correlationId: input.correlationId,
  };
  return {
    acquire: verifiedCopies(binary.helperPath, binary.pin, drives),
    readRoots,
    mavenRepository,
    ...(stepNode.outcome === "patched" ? { stepNode: windowsStepNodeFor(stepNode, input) } : {}),
  };
}
