// #4496 (ADR-0043 D21): the private execution root of a Windows verification run. An access entry
// cannot keep a credential-named file away from a tree that may modify the workspace (#4493 finding
// 5), so the steps run in a copy that leaves every credential-named entry and every link out. The
// copy is made once, after the dependency bootstrap installed into the workspace, shared by the
// run's steps, and removed when the run ends. Counts only on the log: never a path or a name.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

export interface PrivateStepWorkspace {
  /** The copy the steps run in; the first call makes it. */
  readonly workspace: () => WorkspaceInfo;
  /** Removes the copy, if one was made. */
  readonly dispose: () => void;
}

function credentialNamed(source: string): boolean {
  return isCredentialNamedSegment(basename(source));
}

function removeCopy(root: string, correlationId: string | undefined): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
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
    removeCopy(root, correlationId);
    throw error;
  }
  return { ...real, root, selectedRoot: root };
}

/** The run's private step workspace for `real`, made on first use. */
export function privateStepWorkspace(
  real: WorkspaceInfo,
  activityLog: ServerLogSink,
  correlationId: string | undefined,
): PrivateStepWorkspace {
  let copy: WorkspaceInfo | undefined;
  return {
    workspace: (): WorkspaceInfo => {
      copy ??= makeCopy(real, activityLog, correlationId);
      return copy;
    },
    dispose: (): void => {
      if (copy !== undefined) removeCopy(copy.root, correlationId);
      copy = undefined;
    },
  };
}
