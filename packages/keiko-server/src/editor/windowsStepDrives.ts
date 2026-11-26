// #4496 (ADR-0043 D21): the drive letters of one Windows verification step. No capability Windows
// grants an AppContainer lists `C:\` or `C:\Users`, and Node.js and Java resolve a path by walking
// every parent of it, so a step that names its directories by their real paths cannot start its
// own toolchain. Each granted directory therefore gets a `subst` drive letter in this logon session
// before the supervisor starts, the step names it only through that letter, and the letters are
// removed when the step ends. Counts only on the log: never a path or a letter.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { WindowsStepDrive } from "@oscharko-dev/keiko-contracts";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { CommandDeniedError } from "@oscharko-dev/keiko-security";
import { resolveSystemBinaryPath } from "@oscharko-dev/keiko-tools";
import { ISOLATION_UNAVAILABLE_DENIAL_PREFIX } from "@oscharko-dev/keiko-verification";
import { correlationIdOrUnknown } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

const WINDOWS_STEP_DRIVES_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.verification.windows-step-drives",
  category: "process",
  owner: "keiko-server",
  emitter: "editor.windowsStepDrives.record",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["mapped", "no-free-letter", "released", "release-failed"],
    },
    driveCount: { type: "integer", dataClass: "count", required: true },
    refusedCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  // A step without its drive letters cannot start its toolchain: it is refused as unavailable.
  failureClasses: ["runtime-confinement-unavailable"],
  proofIds: ["editor.verification.windows-step-drives.emitted-line"],
  releaseImpact: "patch",
});

/** How drive letters are defined in this logon session; injectable for tests. */
export interface WindowsDriveHost {
  /** Defines the letter (such as `"K:"`) as `root`; false when Windows refused it. */
  readonly define: (drive: string, root: string) => boolean;
  /** Removes the letter; false when Windows refused it. */
  readonly remove: (drive: string) => boolean;
}

export interface WindowsStepDriveScope {
  readonly host: WindowsDriveHost;
  readonly activityLog: ServerLogSink;
  readonly correlationId: string | undefined;
}

// A, B and C stay the system's; the step tries `Z:` down to `D:`. Windows refuses a letter that
// names a drive already, also a disconnected network drive, which is never probed (a probe of one
// can stall); such a letter is skipped.
const LETTERS = Array.from({ length: 23 }, (_, index) => `${String.fromCodePoint(90 - index)}:`);
// A directory below a drive root; a drive's own root needs no letter, a UNC path cannot take one.
const DRIVE_DIRECTORY = /^[A-Za-z]:\\.*[^\\/]$/u;
const SUBST_TIMEOUT_MS = 3000;

type DriveOutcome = "mapped" | "no-free-letter";

function withoutTrailingSeparator(value: string): string {
  let end = value.length;
  while (end > 0 && (value.charAt(end - 1) === "\\" || value.charAt(end - 1) === "/")) end--;
  return value.slice(0, end);
}

// Each directory once, ignoring case and a trailing separator.
function distinctRoots(roots: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const root of roots.map(withoutTrailingSeparator)) {
    const key = root.toLowerCase();
    if (!DRIVE_DIRECTORY.test(root) || seen.has(key)) continue;
    seen.add(key);
    distinct.push(root);
  }
  return distinct;
}

interface LetterPool {
  readonly free: string[];
  refused: number;
}

function defineOne(root: string, pool: LetterPool, host: WindowsDriveHost): string | undefined {
  for (let drive = pool.free.shift(); drive !== undefined; drive = pool.free.shift()) {
    if (host.define(drive, root)) return drive;
    pool.refused++;
  }
  return undefined;
}

/** Removes each letter; returns how many Windows refused to remove. */
export function removeWindowsStepDrives(
  drives: readonly WindowsStepDrive[],
  host: WindowsDriveHost,
): number {
  return drives.filter(({ drive }) => !host.remove(drive)).length;
}

/**
 * Defines a letter for each distinct granted directory into `drives`, until one cannot get a
 * letter. `drives` belongs to the caller, so a host that throws midway leaves no letter unknown.
 */
export function defineWindowsStepDrives(
  roots: readonly string[],
  host: WindowsDriveHost,
  drives: WindowsStepDrive[],
): { readonly outcome: DriveOutcome; readonly refusedCount: number } {
  const pool: LetterPool = { free: [...LETTERS], refused: 0 };
  for (const root of distinctRoots(roots)) {
    const drive = defineOne(root, pool, host);
    if (drive === undefined) return { outcome: "no-free-letter", refusedCount: pool.refused };
    drives.push({ root, drive });
  }
  return { outcome: "mapped", refusedCount: pool.refused };
}

function record(
  scope: WindowsStepDriveScope,
  outcome: DriveOutcome | "released" | "release-failed",
  driveCount: number,
  refusedCount: number,
): void {
  scope.activityLog.write(
    activityLogEvent(
      WINDOWS_STEP_DRIVES_OPERATION,
      { correlationId: correlationIdOrUnknown(scope.correlationId) },
      { outcome, driveCount, refusedCount },
    ),
  );
}

function stepRefusal(): CommandDeniedError {
  return new CommandDeniedError(
    `${ISOLATION_UNAVAILABLE_DENIAL_PREFIX}no drive letter could name the step's directories`,
    "subst.exe",
  );
}

function diagnose(scope: WindowsStepDriveScope, operation: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(scope.correlationId),
      operation,
      source: "editor.verification.windows-step-drives",
      error,
      redact: () => "The drive letters of a Windows step could not be managed.",
    }),
  );
}

/** The step's drive letters; refuses the step as isolation unavailable when they cannot exist. */
export function mapWindowsStepDrives(
  roots: readonly string[],
  scope: WindowsStepDriveScope,
): readonly WindowsStepDrive[] {
  const drives: WindowsStepDrive[] = [];
  let definition: ReturnType<typeof defineWindowsStepDrives>;
  try {
    definition = defineWindowsStepDrives(roots, scope.host, drives);
  } catch (error) {
    diagnose(scope, "editor.verification.windows-step-drives.define-failed", error);
    unmapWindowsStepDrives(drives, scope);
    throw stepRefusal();
  }
  record(scope, definition.outcome, drives.length, definition.refusedCount);
  if (definition.outcome === "mapped") return drives;
  unmapWindowsStepDrives(drives, scope);
  throw stepRefusal();
}

/** Removes the step's letters; a letter Windows keeps is recorded, never thrown. */
export function unmapWindowsStepDrives(
  drives: readonly WindowsStepDrive[],
  scope: WindowsStepDriveScope,
): void {
  if (drives.length === 0) return;
  try {
    const failed = removeWindowsStepDrives(drives, scope.host);
    record(scope, failed === 0 ? "released" : "release-failed", drives.length, failed);
  } catch (error) {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: correlationIdOrUnknown(scope.correlationId),
        operation: "editor.verification.windows-step-drives.release-failed",
        source: "editor.verification.windows-step-drives",
        error,
        redact: () => "The drive letters of a Windows step could not be removed.",
      }),
    );
  }
}

/** `subst.exe` from System32, never from `PATH`, in this process's logon session. */
export function nodeWindowsDriveHost(env: NodeJS.ProcessEnv): WindowsDriveHost {
  const subst = (args: readonly string[]): boolean => {
    const result = spawnSync(resolveSystemBinaryPath("subst.exe", env), args, {
      stdio: "ignore",
      windowsHide: true,
      timeout: SUBST_TIMEOUT_MS,
    });
    return result.error === undefined && result.status === 0;
  };
  return {
    // A letter subst reported but Windows does not show is not the step's.
    define: (drive, root) => subst([drive, root]) && existsSync(`${drive}\\`),
    remove: (drive) => subst([drive, "/D"]),
  };
}
