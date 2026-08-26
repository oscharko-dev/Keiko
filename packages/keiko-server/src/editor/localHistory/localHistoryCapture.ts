import { randomUUID } from "node:crypto";
import type {
  EditorLocalHistoryOrigin,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import type { FilesContentResponse } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "../../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../../correlation.js";
import { emitServerDiagnostic } from "../../diagnostics-log.js";
import { errorKindOf, type ServerLogSink } from "../../observability/index.js";
import { processServerLogSink } from "../../process-log-sink.js";
import {
  resolveCurrentWorkspaceRootMembership,
  WorkspaceRootMembershipError,
} from "../../workspace-root-membership.js";
import { EditorLocalHistoryError, editorLocalHistoryWorkspaceId } from "./localHistoryStore.js";

// #2906 review (comment 3863185711): a rename-triggered reKey failure is not a checkpoint
// capture, so it must never be mislabeled under a real EditorLocalHistoryOrigin (a rename can hit
// this failure path no matter which origin captured the checkpoints being renamed). Kept as a
// sibling union rather than widening EditorLocalHistoryOrigin itself: that contract type is the
// closed vocabulary a PERSISTED checkpoint's `origin` field is validated against
// (isHistoryOrigin/EDITOR_LOCAL_HISTORY_ORIGINS in localHistoryStore.ts's contract), and a reKey
// never produces a new checkpoint, so it has no `origin` of that kind to report.
export type EditorLocalHistoryDiagnosticOrigin =
  EditorLocalHistoryOrigin | "editor.local-history.rekey";

const REKEY_DIAGNOSTIC_ORIGIN: EditorLocalHistoryDiagnosticOrigin = "editor.local-history.rekey";

export interface EditorLocalHistoryResolvedRoot {
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly objectIdentityDigest: string;
  readonly realRoot: string;
}

export type EditorLocalHistoryCaptureProtection = NonNullable<
  FilesContentResponse["localHistoryProtection"]
>;

function unavailableRoot(detail: string): never {
  throw new EditorLocalHistoryError(
    "INVALID_CAPTURE",
    "Local-history workspace is unavailable.",
    detail,
  );
}

export function resolveEditorLocalHistoryRoot(
  deps: Pick<UiHandlerDeps, "store">,
  realRootInput: string,
): EditorLocalHistoryResolvedRoot {
  try {
    const membership = resolveCurrentWorkspaceRootMembership(deps.store, realRootInput);
    // Membership still decides ACCESS — a root outside every manifest has no history surface. It
    // no longer decides IDENTITY: the history workspace is derived from the root, so joining or
    // leaving a multi-root workspace carries this root's checkpoints along instead of stranding
    // them under a manifest id the root no longer has (#2616).
    return {
      ...membership,
      workspaceId: editorLocalHistoryWorkspaceId(membership.rootRef),
    };
  } catch (error) {
    return unavailableRoot(
      error instanceof WorkspaceRootMembershipError ? error.failure : "ROOT_UNRESOLVED",
    );
  }
}

function captureFailureCode(error: unknown): string {
  if (!(error instanceof EditorLocalHistoryError)) return "LOCAL_HISTORY_CAPTURE_FAILED";
  return error.detail === undefined
    ? `LOCAL_HISTORY_${error.code}`
    : `LOCAL_HISTORY_${error.code}_${error.detail}`;
}

export function emitEditorLocalHistoryCaptureFailure(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  origin: EditorLocalHistoryDiagnosticOrigin,
  error: unknown,
  nowMs = Date.now(),
  // Threads the request's own correlation id (ADR-0173 D5 / g12) when the caller has one in
  // scope, so this failure — and the client-visible protection payload it returns the id on —
  // joins the SAME id as the rest of the request's trail instead of a disconnected mint.
  requestCorrelationId?: string,
): string {
  const correlationId = requestCorrelationId ?? `local-history-${randomUUID()}`;
  emitServerDiagnostic(deps.diagnostics, {
    correlationId,
    timestamp: new Date(nowMs).toISOString(),
    operation: origin,
    source: "editor.local-history.capture",
    errorClass: "EditorLocalHistoryCaptureError",
    message: "Editor local-history capture failed.",
    code: captureFailureCode(error),
  });
  return correlationId;
}

function degradedProtection(
  error: unknown,
  correlationId: string,
): EditorLocalHistoryCaptureProtection {
  let reason: "filesystem-identity-unsupported" | "workspace-unavailable" | "history-unavailable" =
    "history-unavailable";
  if (
    error instanceof EditorLocalHistoryError &&
    error.detail === "FILESYSTEM_IDENTITY_UNSUPPORTED"
  ) {
    reason = "filesystem-identity-unsupported";
  } else if (error instanceof EditorLocalHistoryError && error.code === "INVALID_CAPTURE") {
    reason = "workspace-unavailable";
  }
  return {
    status: "degraded",
    reason,
    correlationId,
  };
}

// A secret-shaped capture is a deliberate protection decision, not unavailable infrastructure — it
// gets its own status instead of being folded into "degraded" (#2898). Kept as a thin branch ahead
// of degradedProtection rather than inside it, since the store-unavailable call site above can never
// produce this error and should keep reading as the plain "degraded" case it always was.
function protectionForCaptureFailure(
  error: unknown,
  correlationId: string,
): EditorLocalHistoryCaptureProtection {
  if (error instanceof EditorLocalHistoryError && error.code === "SECRET_CONTENT_SUPPRESSED") {
    return { status: "suppressed", reason: "secret-detected", correlationId };
  }
  return degradedProtection(error, correlationId);
}

// KEIKO-0675: rename-driven re-key wrapper mirroring captureEditorLocalHistorySafely's shape.
// Fail-safe: a re-key failure never breaks the rename response; it emits a body-free diagnostic
// AND a body-free activity-log line (#2906 review, comment 3863185711), then returns 0 rewritten
// entries. `activityLog` defaults to the same process-wide ServerLogSink every other server
// operation writes through (mirrors gitDelivery/execution.ts's `seams.activityLog ??
// processServerLogSink()` seam) so production observability holds with zero composition-root
// wiring, while a test can still inject a capturing sink to assert on the emitted line.
//
// Before this fix the returned rewritten-entry count was silently discarded by the rename route
// (files.ts) — never logged anywhere — and the failure path mislabeled itself under the real
// checkpoint-capture origin "user-save", making a rename-triggered failure indistinguishable from
// an ordinary user-save capture failure in both the diagnostic and (via its activity-log bridge)
// the activity log.
export function reKeyEditorLocalHistorySafely(input: {
  readonly deps: Pick<UiHandlerDeps, "store" | "editorLocalHistoryStore" | "diagnostics"> & {
    readonly activityLog?: ServerLogSink | undefined;
  };
  readonly realRoot: string;
  readonly previousRelativePath: string;
  readonly nextRelativePath: string;
  readonly correlationId?: string | undefined;
}): number {
  if (input.deps.editorLocalHistoryStore === undefined) return 0;
  const activityLog = input.deps.activityLog ?? processServerLogSink();
  const correlationId = input.correlationId ?? UNKNOWN_CORRELATION_ID;
  try {
    const identity = resolveEditorLocalHistoryRoot(input.deps, input.realRoot);
    const rewrittenCount = input.deps.editorLocalHistoryStore.reKey(
      identity,
      input.previousRelativePath,
      input.nextRelativePath,
    );
    activityLog.write({
      category: "diagnostic",
      op: "editor.local-history.rekey.completed",
      correlationId,
      extra: { outcome: "succeeded", rewrittenCount },
    });
    return rewrittenCount;
  } catch (error) {
    emitEditorLocalHistoryCaptureFailure(
      input.deps,
      REKEY_DIAGNOSTIC_ORIGIN,
      error,
      Date.now(),
      input.correlationId,
    );
    activityLog.write({
      level: "error",
      category: "diagnostic",
      op: "editor.local-history.rekey.failed",
      correlationId,
      errorKind: errorKindOf(error),
      extra: { outcome: "failed", rewrittenCount: 0 },
    });
    return 0;
  }
}

export function captureEditorLocalHistorySafely(input: {
  readonly deps: Pick<UiHandlerDeps, "store" | "editorLocalHistoryStore" | "diagnostics">;
  readonly realRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly origin: EditorLocalHistoryOrigin;
  readonly nowMs?: number | undefined;
  // The request's own correlation id (ADR-0173 D5 / g12), when the caller has one in scope.
  readonly correlationId?: string | undefined;
}): EditorLocalHistoryCaptureProtection {
  if (input.deps.editorLocalHistoryStore === undefined) {
    const error = new EditorLocalHistoryError(
      "INDEX_UNAVAILABLE",
      "Editor Local History is unavailable.",
      "STORE_UNAVAILABLE",
    );
    const correlationId = emitEditorLocalHistoryCaptureFailure(
      input.deps,
      input.origin,
      error,
      input.nowMs,
      input.correlationId,
    );
    return degradedProtection(error, correlationId);
  }
  try {
    const identity = resolveEditorLocalHistoryRoot(input.deps, input.realRoot);
    input.deps.editorLocalHistoryStore.capture({
      ...identity,
      relativePath: input.relativePath,
      absolutePath: input.absolutePath,
      content: input.content,
      origin: input.origin,
      nowMs: input.nowMs,
    });
    return { status: "protected" };
  } catch (error) {
    const correlationId = emitEditorLocalHistoryCaptureFailure(
      input.deps,
      input.origin,
      error,
      input.nowMs,
      input.correlationId,
    );
    return protectionForCaptureFailure(error, correlationId);
  }
}
