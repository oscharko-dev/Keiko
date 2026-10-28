import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  describeError,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";

// A run id as the composition mints it (`run-<decimal>`) and as every fixture spells it; nothing
// else under the owned directory is ever treated as a run's state.
const RUN_STATE_DIRECTORY_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

export interface OrphanedRunStateSweepInput {
  /** The owned directory that holds one subdirectory per run: `<state>/coding-runtime/opencode`. */
  readonly stateBaseRoot: string;
  /** Whether a run is live or can still be recovered; its directory is then left alone. */
  readonly isRetained: (runId: string) => boolean;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  /** Removal seam for fault injection; production removes with `rmSync`. */
  readonly remove?: ((path: string) => void) | undefined;
}

export interface OrphanedRunStateSweepResult {
  readonly scanned: number;
  readonly removed: number;
  readonly retained: number;
  readonly skipped: number;
  readonly failed: number;
}

const NOTHING: OrphanedRunStateSweepResult = {
  scanned: 0,
  removed: 0,
  retained: 0,
  skipped: 0,
  failed: 0,
};

function isOwnedDirectory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
}

/**
 * Removes the per-run state directories that belong to no live or recoverable run: a crash or a
 * disposal that failed leaves the run's OpenCode database, configuration and temporary files behind
 * (audit 2026-10, finding 8). Only the owned base directory is scanned, only real directories with
 * a run-shaped name inside it are removed, a symbolic link is never followed or removed, and a
 * directory owned by another user is left alone. The result is counts only; nothing a directory
 * held, and no path, is ever recorded.
 */
export function sweepOrphanedOpenCodeRunState(
  input: OrphanedRunStateSweepInput,
): OrphanedRunStateSweepResult {
  let names: readonly string[];
  try {
    if (!isOwnedDirectory(input.stateBaseRoot)) return NOTHING;
    names = readdirSync(input.stateBaseRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    recordSweep(input.diagnostics, { ...NOTHING, failed: 1 }, error);
    return { ...NOTHING, failed: 1 };
  }
  const result = sweepEntries(input, names);
  if (result.removed > 0 || result.failed > 0) recordSweep(input.diagnostics, result, undefined);
  return result;
}

// The failures that are recorded one by one; the summary line still counts all of them.
const MAX_RECORDED_REMOVAL_FAILURES = 8;

function sweepEntries(
  input: OrphanedRunStateSweepInput,
  names: readonly string[],
): OrphanedRunStateSweepResult {
  let removed = 0;
  let retained = 0;
  let skipped = 0;
  let failed = 0;
  for (const name of names) {
    if (!RUN_STATE_DIRECTORY_NAME.test(name)) {
      skipped += 1;
    } else if (input.isRetained(name)) {
      retained += 1;
    } else {
      try {
        removeRunDirectory(join(input.stateBaseRoot, name), input.remove);
        removed += 1;
      } catch (cause) {
        failed += 1;
        if (failed <= MAX_RECORDED_REMOVAL_FAILURES) recordRemovalFailure(input.diagnostics, cause);
      }
    }
  }
  return { scanned: names.length, removed, retained, skipped, failed };
}

function removeRunDirectory(path: string, remove: ((path: string) => void) | undefined): void {
  // Re-checked at removal: an entry replaced by a link or a foreign directory since the scan stays.
  if (!isOwnedDirectory(path)) throw new Error("opencode-run-state-not-owned");
  const removal =
    remove ??
    ((target: string): void => {
      rmSync(target, { recursive: true, force: true });
    });
  removal(path);
}

function recordSweep(
  diagnostics: ServerDiagnosticSink | undefined,
  counts: OrphanedRunStateSweepResult,
  error: unknown,
): void {
  const detail = error === undefined ? undefined : describeError(error);
  emitServerDiagnostic(diagnostics, {
    correlationId: UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.run-state",
    source: "opencode.run-state.sweep",
    errorClass: detail?.errorClass ?? "OpenCodeOrphanedRunState",
    message: "runtime-lifecycle-failed",
    code: `stage=startup:reason=orphaned-run-state:scanned=${String(counts.scanned)}:removed=${String(counts.removed)}:retained=${String(counts.retained)}:skipped=${String(counts.skipped)}:failed=${String(counts.failed)}`,
    ...(detail?.frames === undefined ? {} : { frames: detail.frames }),
    ...(detail?.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
  });
}

// One removal that failed: its error class and Keiko frames, never the path or the error text.
function recordRemovalFailure(diagnostics: ServerDiagnosticSink | undefined, error: unknown): void {
  const detail = describeError(error);
  emitServerDiagnostic(diagnostics, {
    correlationId: UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.run-state",
    source: "opencode.run-state.sweep",
    errorClass: detail.errorClass,
    message: "runtime-lifecycle-failed",
    code: "stage=startup:reason=orphaned-run-state-remove-failed",
    ...(detail.frames === undefined ? {} : { frames: detail.frames }),
    ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
  });
}
