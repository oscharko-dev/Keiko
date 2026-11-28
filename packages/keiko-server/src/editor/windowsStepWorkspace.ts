// #4496 (ADR-0043 D21): the private execution root of a Windows verification run. An access entry
// cannot keep a credential-named file away from a tree that may modify the workspace (#4493 finding
// 5), so the steps run in a copy that leaves every credential-named entry and every link out. The
// copy is made once, after the dependency bootstrap installed into the workspace, shared by the
// run's steps, and removed when the run ends. Counts only on the log: never a path or a name.

import { mkdtempSync, realpathSync, rmSync, type RmOptions } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { isCredentialNamedSegment, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { correlationIdOrUnknown } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { copyWithoutLinks } from "./linkFreeCopy.js";

const WINDOWS_STEP_COPY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.verification.windows-step-copy",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.windowsStepWorkspace.copy",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["copied"],
    },
    copiedEntryCount: { type: "integer", dataClass: "count", required: true },
    skippedLinkCount: { type: "integer", dataClass: "count", required: true },
    skippedCredentialCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["editor-assured-copy-containment"],
  proofIds: ["editor.verification.windows-step-copy.credentials-skipped"],
  releaseImpact: "patch",
});

/** What removing a run's step copy took: its wall time and how often the removal was retried. */
export interface StepCopyCleanup {
  readonly durationMs: number;
  readonly retryCount: number;
}

export interface PrivateStepWorkspace {
  /** The copy the steps run in; the first call makes it. */
  readonly workspace: () => WorkspaceInfo;
  /**
   * Removes the copy, if one was made, and settles only once it is gone (or the removal failed and
   * was recorded), so the next execution of the exclusive scope never starts beside a half-removed
   * copy. `undefined` when no copy was made.
   */
  readonly dispose: () => Promise<StepCopyCleanup | undefined>;
}

/** The removal's seams: tests inject faults and a recording delay, never a real wait. */
export interface StepCopyRemovalHost {
  readonly remove?: ((path: string, options: RmOptions) => Promise<void>) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

function credentialNamed(source: string): boolean {
  return isCredentialNamedSegment(basename(source));
}

// The retry policy of Node's own recursive removal (`maxRetries: 5`, `retryDelay: 100`, a delay that
// grows with each attempt, the same transient codes), applied here so a retry can be counted.
const REMOVE_MAX_RETRIES = 5;
const REMOVE_RETRY_DELAY_MS = 100;
const RETRYABLE_REMOVAL_CODES: ReadonlySet<string> = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

function retryableRemoval(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && RETRYABLE_REMOVAL_CODES.has(error.code);
}

function reportCleanupFailure(error: unknown, correlationId: string | undefined): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(correlationId),
      operation: "editor.verification.windows-step-copy.cleanup-failed",
      source: "editor.verification.windows-step-copy",
      error,
      redact: () => "A private step copy could not be removed.",
    }),
  );
}

// Used only where the copy is being made and the caller is synchronous: a copy that failed halfway.
function removeCopySync(root: string, correlationId: string | undefined): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    reportCleanupFailure(error, correlationId);
  }
}

// One removal attempt, then (after a growing pause) the next, until it succeeds, the failure is not
// retryable or the retries are spent; the attempts are sequential by construction.
async function removeWithRetries(
  remove: NonNullable<StepCopyRemovalHost["remove"]>,
  sleep: (ms: number) => Promise<void>,
  root: string,
  correlationId: string | undefined,
  retryCount: number,
): Promise<number> {
  try {
    await remove(root, { recursive: true, force: true });
    return retryCount;
  } catch (error) {
    if (retryCount >= REMOVE_MAX_RETRIES || !retryableRemoval(error)) {
      reportCleanupFailure(error, correlationId);
      return retryCount;
    }
    await sleep(REMOVE_RETRY_DELAY_MS * (retryCount + 1));
    return removeWithRetries(remove, sleep, root, correlationId, retryCount + 1);
  }
}

async function removeCopy(
  root: string,
  correlationId: string | undefined,
  host: StepCopyRemovalHost,
): Promise<StepCopyCleanup> {
  const remove = host.remove ?? rm;
  const sleep =
    host.sleep ?? ((ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms)));
  const clock = host.now ?? Date.now;
  const startedAtMs = clock();
  const retryCount = await removeWithRetries(remove, sleep, root, correlationId, 0);
  return { durationMs: Math.max(0, clock() - startedAtMs), retryCount };
}

function makeCopy(
  real: WorkspaceInfo,
  activityLog: ServerLogSink,
  correlationId: string | undefined,
): WorkspaceInfo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-step-")));
  try {
    const counts = copyWithoutLinks(real.root, root, credentialNamed);
    activityLog.write(
      activityLogEvent(
        WINDOWS_STEP_COPY_OPERATION,
        { correlationId: correlationIdOrUnknown(correlationId) },
        {
          outcome: "copied",
          copiedEntryCount: counts.copiedEntryCount,
          skippedLinkCount: counts.skippedLinkCount,
          skippedCredentialCount: counts.excludedEntryCount,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    // Synchronous on purpose: `workspace()` is a synchronous port and this is the rare half-built
    // copy of a failed copy; the common removal, after the run, is the asynchronous one.
    removeCopySync(root, correlationId);
    throw error;
  }
  return { ...real, root, selectedRoot: root };
}

/** The run's private step workspace for `real`, made on first use. */
export function privateStepWorkspace(
  real: WorkspaceInfo,
  activityLog: ServerLogSink,
  correlationId: string | undefined,
  host: StepCopyRemovalHost = {},
): PrivateStepWorkspace {
  let copy: WorkspaceInfo | undefined;
  return {
    workspace: (): WorkspaceInfo => {
      copy ??= makeCopy(real, activityLog, correlationId);
      return copy;
    },
    dispose: async (): Promise<StepCopyCleanup | undefined> => {
      if (copy === undefined) return undefined;
      const { root } = copy;
      copy = undefined;
      return removeCopy(root, correlationId, host);
    },
  };
}
