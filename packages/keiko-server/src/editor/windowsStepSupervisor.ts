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
import { NATIVE_HOME_DENIED_LOCATIONS } from "@oscharko-dev/keiko-sandbox";
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
    // #4496: named toolchain homes left out, by reason: they are a drive root, hold or sit in the
    // profile's `.m2`, hold or sit in a credential store or hold a credential-named entry, or
    // cannot be listed. Never their paths.
    readRootRefusedDriveRootCount: { type: "integer", dataClass: "count", required: true },
    readRootRefusedM2Count: { type: "integer", dataClass: "count", required: true },
    readRootRefusedCredentialCount: { type: "integer", dataClass: "count", required: true },
    readRootRefusedUnlistableCount: { type: "integer", dataClass: "count", required: true },
    // #4496: whether the person's profile folder is known; without it every step is refused.
    profileKnown: { type: "boolean", dataClass: "closed-enum", required: true },
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
    // #4496: which check a `mismatch` missed; `none` for the other outcomes.
    stepNodeMismatch: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "not-real-folder",
        "extra-entries",
        "not-ordinary-file",
        "size",
        "hash",
        "unreadable",
      ],
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

/** The two file-system reads `realDirectory` makes; injectable so a test can make them throw. */
export interface RealDirectoryFs {
  readonly isDirectory: (path: string) => boolean | undefined;
  readonly realpath: (path: string) => string;
}

const NODE_REAL_DIRECTORY_FS: RealDirectoryFs = {
  isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory(),
  realpath: (path) => realpathSync.native(path),
};

// The real path: long names for 8.3 ones, links and junctions resolved, so every containment test
// below compares the folders a grant actually reads (#4496). A folder that cannot be resolved (an
// unreadable ancestor, a reparse point the resolver refuses) is no folder: a named home is then left
// out, a step's own toolchain folder refused, and an unresolvable profile refuses every step.
export function realDirectory(
  value: string | undefined,
  fs: RealDirectoryFs = NODE_REAL_DIRECTORY_FS,
): string | undefined {
  return realDrivePath(value, fs, true);
}

// The real drive path of an existing file or folder: a protected location such as `.netrc` or
// `.git-credentials` is a file, and a link can place it inside a toolchain folder just as a
// junction places a folder there. One that cannot be resolved keeps only its named path.
export function realLocation(
  value: string,
  fs: RealDirectoryFs = NODE_REAL_DIRECTORY_FS,
): string | undefined {
  return realDrivePath(value, fs, false);
}

function realDrivePath(
  value: string | undefined,
  fs: RealDirectoryFs,
  directoryOnly: boolean,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  const path = win32.normalize(value);
  if (!DRIVE_PATH.test(path)) return undefined;
  try {
    if (directoryOnly && fs.isDirectory(path) !== true) return undefined;
    const real = win32.normalize(fs.realpath(path));
    return DRIVE_PATH.test(real) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** What the read-root check asks of the file system; injectable so tests need no Windows host. */
export interface WindowsReadRootHost {
  /** The directory's real drive path, or `undefined` when it is none (missing, a file, UNC). */
  readonly realDirectory: (value: string | undefined) => string | undefined;
  /** A file's or directory's real drive path, or `undefined` when it is missing or unresolvable. */
  readonly realLocation: (value: string) => string | undefined;
  /** The directory's entry names, or `undefined` when it cannot be listed. */
  readonly entryNames: (directory: string) => readonly string[] | undefined;
}

// An unlistable home is refused by `readRootRefusal` and counted as `unlistable`.
function listEntryNames(directory: string): readonly string[] | undefined {
  try {
    return readdirSync(directory);
  } catch {
    return undefined;
  }
}

const NODE_READ_ROOT_HOST: WindowsReadRootHost = {
  realDirectory: (value) => realDirectory(value),
  realLocation: (value) => realLocation(value),
  entryNames: listEntryNames,
};

// Whether `child` is `parent` or lies inside it, with Windows' case-insensitive comparison.
function windowsPathContains(parent: string, child: string): boolean {
  const relative = win32.relative(parent, child);
  const leaves = relative === ".." || relative.startsWith("..\\");
  return !leaves && !win32.isAbsolute(relative);
}

/** Why a toolchain folder is not granted to a step; closed, so the log names it without a path. */
export type WindowsReadRootRefusal = "drive-root" | "m2" | "credential" | "unlistable";

// The profile's credential stores, as the macOS profile denies them under the home, plus the
// Windows stores of the same kind (#4496). A read root may neither hold nor sit in one.
const WINDOWS_PROFILE_CREDENTIAL_LOCATIONS: readonly string[] = Object.freeze([
  ...NATIVE_HOME_DENIED_LOCATIONS,
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Roaming/Microsoft/Protect",
  "AppData/Roaming/Microsoft/Crypto",
  "AppData/Roaming/GitHub CLI",
]);

// A drive's root directory (`D:\`): granting it would open the whole drive for reading.
const DRIVE_ROOT = /^[A-Za-z]:\\$/u;

// Each protected location (a folder or a file) where the profile names it and, when it differs,
// where it really lies.
function protectedFolders(named: readonly string[], host: WindowsReadRootHost): readonly string[] {
  return named.flatMap((folder) => {
    const resolved = host.realLocation(folder);
    return resolved === undefined || resolved === folder ? [folder] : [folder, resolved];
  });
}

function overlapsAny(root: string, folders: readonly string[]): boolean {
  return folders.some(
    (folder) => windowsPathContains(root, folder) || windowsPathContains(folder, root),
  );
}

// A drive root opens the whole drive. A folder that holds or sits inside the profile's `.m2` would
// hand a read of its settings and their credentials to the step; `MAVEN_HOME\conf` (Maven's own
// global settings) stays readable. The same holds for the profile's credential stores. All paths
// are real ones, and each protected folder is compared both where it is named and where it really
// lies, so a short name, a junction or a relocated folder cannot hide the overlap.
function readRootRefusal(
  root: string,
  protectedRoots: { readonly m2: readonly string[]; readonly credential: readonly string[] },
  host: WindowsReadRootHost,
): WindowsReadRootRefusal | undefined {
  if (DRIVE_ROOT.test(root)) return "drive-root";
  if (overlapsAny(root, protectedRoots.m2)) return "m2";
  if (overlapsAny(root, protectedRoots.credential)) return "credential";
  // A folder that cannot be listed cannot be shown free of credentials, so it is refused.
  const names = host.entryNames(root);
  if (names === undefined) return "unlistable";
  return names.some(isCredentialNamedSegment) ? "credential" : undefined;
}

type ReadRootAdmission = (root: string) => {
  readonly root?: string;
  readonly refusal?: WindowsReadRootRefusal;
};

// The admission of an already real folder against the profile's `.m2` and credential stores, named
// and resolved. They are resolved again on every admission, so one relocated after the supervisor
// was resolved is seen.
function realReadRootAdmission(profile: string, host: WindowsReadRootHost): ReadRootAdmission {
  const m2 = [win32.join(profile, ".m2")];
  const credential = WINDOWS_PROFILE_CREDENTIAL_LOCATIONS.map((location) =>
    win32.join(profile, location),
  );
  return (root) => {
    const refusal = readRootRefusal(
      root,
      { m2: protectedFolders(m2, host), credential: protectedFolders(credential, host) },
      host,
    );
    return refusal === undefined ? { root } : { refusal };
  };
}

/**
 * The read-root admission every toolchain folder of a step passes: the named folder's real path,
 * or `undefined` when it is none or is refused. Without a known profile nothing is admitted.
 */
export function windowsReadRootAdmission(
  profile: string | undefined,
  host: WindowsReadRootHost = NODE_READ_ROOT_HOST,
): (directory: string | undefined) => {
  readonly root?: string;
  readonly refusal?: WindowsReadRootRefusal;
} {
  if (profile === undefined) return () => ({});
  const admit = realReadRootAdmission(profile, host);
  return (directory) => {
    const root = host.realDirectory(directory);
    return root === undefined ? {} : admit(root);
  };
}

/** How many named homes each refusal left out, for the supervisor line. */
export type WindowsReadRootRefusals = Readonly<Record<WindowsReadRootRefusal, number>>;

export function windowsStepReadRoots(
  env: NodeJS.ProcessEnv,
  host: WindowsReadRootHost = NODE_READ_ROOT_HOST,
): {
  readonly roots: readonly string[];
  readonly profile: string | undefined;
  readonly refused: WindowsReadRootRefusals;
} {
  const profile = host.realDirectory(env.USERPROFILE);
  const refused = { "drive-root": 0, m2: 0, credential: 0, unlistable: 0 };
  if (profile === undefined) return { roots: Object.freeze([]), profile, refused };
  const admit = realReadRootAdmission(profile, host);
  // Each real folder is judged and counted once, however many homes name it.
  const folders = new Set<string>();
  for (const name of READ_ROOT_VARIABLES) {
    const folder = host.realDirectory(env[name]);
    if (folder !== undefined) folders.add(folder);
  }
  const roots: string[] = [];
  for (const folder of folders) {
    const { root, refusal } = admit(folder);
    if (root !== undefined) roots.push(root);
    if (refusal !== undefined) refused[refusal] += 1;
  }
  return { roots: Object.freeze(roots), profile, refused: Object.freeze(refused) };
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

// The one supervisor line a resolution writes: counts, closed values and flags, never a path.
function recordResolution(
  input: WindowsStepSupervisorInput,
  resolved: {
    readonly outcome: SupervisorBinary["outcome"];
    readonly readRoots: readonly string[];
    readonly refused: WindowsReadRootRefusals;
    readonly profile: string | undefined;
    readonly mavenRepository: string | undefined;
    readonly stepNode: ReturnType<typeof resolveStepNode>;
  },
): void {
  const { refused, stepNode } = resolved;
  input.activityLog.write(
    activityLogEvent(
      WINDOWS_STEP_SUPERVISOR_OPERATION,
      { correlationId: input.correlationId ?? UNKNOWN_CORRELATION_ID },
      {
        outcome: resolved.outcome,
        readRootCount: resolved.readRoots.length,
        readRootRefusedDriveRootCount: refused["drive-root"],
        readRootRefusedM2Count: refused.m2,
        readRootRefusedCredentialCount: refused.credential,
        readRootRefusedUnlistableCount: refused.unlistable,
        profileKnown: resolved.profile !== undefined,
        mavenRepository: resolved.mavenRepository !== undefined,
        stepNode: stepNode.outcome,
        stepNodeMismatch: stepNode.outcome === "mismatch" ? stepNode.mismatch : "none",
      },
    ),
  );
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
  const { roots: readRoots, profile, refused } = windowsStepReadRoots(env);
  const mavenRepository = (input.mavenRepository ?? windowsMavenRepository)(env);
  const stepNode = verifiedStepNode(binary, input);
  // Checked again for each step's own toolchain folder, so a credential added later is seen too.
  const admitReadRoot = windowsReadRootAdmission(profile);
  recordResolution(input, {
    outcome: binary.outcome,
    readRoots,
    refused,
    profile,
    mavenRepository,
    stepNode,
  });
  if (binary.outcome !== "available") return undefined;
  const drives: WindowsStepDriveScope = {
    host: input.driveHost ?? nodeWindowsDriveHost(env),
    activityLog: input.activityLog,
    correlationId: input.correlationId,
  };
  return {
    acquire: verifiedCopies(binary.helperPath, binary.pin, drives),
    readRoots,
    profile,
    admitReadRoot: (directory) => admitReadRoot(directory).root,
    mavenRepository,
    ...(stepNode.outcome === "patched" ? { stepNode: windowsStepNodeFor(stepNode, input) } : {}),
  };
}
