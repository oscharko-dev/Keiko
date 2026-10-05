import {
  PathDeniedError,
  WorkspaceNotFoundError,
  resolveExistingAllowedWorkspaceRealRoot,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "./correlation.js";
import type { ServerLogSink } from "./observability/index.js";
import {
  causeChain,
  keikoStackFrames,
  errorKindOf,
  safeProperty,
} from "@oscharko-dev/keiko-activity-log";
import { processServerLogSink } from "./process-log-sink.js";

export type WorkspaceRootDenialReason =
  | "denied-locus"
  | "ordinary-root-unavailable"
  | "credential-shaped-root"
  | "managed-root-session-authority-missing"
  | "managed-authority-unavailable"
  | "managed-root-ownership"
  | "managed-root-not-registered"
  | "managed-root-lifecycle"
  | "managed-root-identity"
  | "managed-root-identity-schema-retired"
  | "managed-root-identity-unsupported"
  | "managed-root-resolution-failed"
  | "managed-root-lifecycle-resolution-failed";

const WORKSPACE_ROOT_DENIED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "workspace.root.denied",
  category: "security",
  owner: "keiko-server",
  emitter: "workspace-root-denial-log.recordWorkspaceRootDenied",
  fields: {
    decision: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["denied"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "denied-locus",
        "ordinary-root-unavailable",
        "credential-shaped-root",
        "managed-root-session-authority-missing",
        "managed-authority-unavailable",
        "managed-root-ownership",
        "managed-root-not-registered",
        "managed-root-lifecycle",
        "managed-root-identity",
        "managed-root-identity-schema-retired",
        "managed-root-identity-unsupported",
        "managed-root-resolution-failed",
        "managed-root-lifecycle-resolution-failed",
      ],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["workspace-root-denial"],
  proofIds: ["workspace.root.denied.line"],
  releaseImpact: "patch",
});

export interface WorkspaceRootDenialLogContext {
  readonly activityLog?: ServerLogSink | undefined;
  readonly correlationId?: string | undefined;
}

export interface WorkspaceRootDenialEvidence {
  readonly reason: WorkspaceRootDenialReason;
  readonly failureKind: string;
  readonly errorKind: ActivityLogErrorKind;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
}

export function recordWorkspaceRootDenied(
  evidence: WorkspaceRootDenialEvidence,
  context: WorkspaceRootDenialLogContext,
): void {
  (context.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      WORKSPACE_ROOT_DENIED_OPERATION,
      {
        level:
          evidence.reason === "ordinary-root-unavailable" ||
          evidence.reason === "credential-shaped-root"
            ? "error"
            : "warn",
        correlationId: correlationIdOrUnknown(context.correlationId),
        errorKind: evidence.errorKind,
      },
      {
        decision: "denied",
        reason: evidence.reason,
        failureKind: evidence.failureKind,
        ...(evidence.frames === undefined ? {} : { frames: evidence.frames }),
        ...(evidence.causeChain === undefined ? {} : { causeChain: evidence.causeChain }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

export function recordWorkspaceRootDenial(
  error: PathDeniedError,
  context: WorkspaceRootDenialLogContext,
): void {
  const frames = keikoStackFrames(error);
  const causes = causeChain(error);
  recordWorkspaceRootDenied(
    {
      reason: "denied-locus",
      failureKind: error.code,
      errorKind: "permission-denied",
      ...(frames.length === 0 ? {} : { frames }),
      ...(causes.length === 0 ? {} : { causeChain: causes }),
    },
    context,
  );
}

// Expected filesystem availability failures may be surfaced as an inaccessible connected root.
// Everything else must retain its original exception and reach the server failure boundary.
const WORKSPACE_ROOT_FILESYSTEM_FAILURES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "ENAMETOOLONG",
  "EINVAL",
]);
const WORKSPACE_ROOT_TRANSIENT_FAILURES: ReadonlySet<string> = new Set([
  "EIO",
  "ESTALE",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
  "ENOTCONN",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENXIO",
  "ENODEV",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETDOWN",
  "ENETUNREACH",
  "ENETRESET",
  "EBUSY",
  "EAGAIN",
]);
const WORKSPACE_ROOT_PERMISSION_FAILURES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);
const WORKSPACE_ROOT_RESOURCE_FAILURES: ReadonlySet<string> = new Set(["EMFILE", "ENFILE"]);

function isKnownWorkspaceFilesystemFailure(kind: string): boolean {
  return (
    WORKSPACE_ROOT_FILESYSTEM_FAILURES.has(kind) || WORKSPACE_ROOT_TRANSIENT_FAILURES.has(kind)
  );
}

export function isExpectedWorkspaceRootFailure(error: unknown): boolean {
  return (
    error instanceof WorkspaceNotFoundError || isKnownWorkspaceFilesystemFailure(errorKindOf(error))
  );
}

function workspaceRootFailureKind(error: unknown): string {
  const causeKind = errorKindOf(safeProperty(error, "cause"));
  return error instanceof WorkspaceNotFoundError && isKnownWorkspaceFilesystemFailure(causeKind)
    ? causeKind
    : errorKindOf(error);
}

export function workspaceRootFailureStatus(error: unknown): 400 | 503 {
  return WORKSPACE_ROOT_TRANSIENT_FAILURES.has(workspaceRootFailureKind(error)) ? 503 : 400;
}

function workspaceRootErrorKind(error: unknown, failureKind: string): ActivityLogErrorKind {
  if (WORKSPACE_ROOT_PERMISSION_FAILURES.has(failureKind)) return "permission-denied";
  if (WORKSPACE_ROOT_RESOURCE_FAILURES.has(failureKind)) return "internal";
  if (failureKind === "ETIMEDOUT") return "timeout";
  return isExpectedWorkspaceRootFailure(error) ? "unavailable" : "internal";
}

export function recordWorkspaceRootUnavailable(
  error: unknown,
  context: WorkspaceRootDenialLogContext,
): void {
  const frames = keikoStackFrames(error);
  const causes = causeChain(error);
  const failureKind = workspaceRootFailureKind(error);
  recordWorkspaceRootDenied(
    {
      reason: "ordinary-root-unavailable",
      failureKind,
      errorKind: workspaceRootErrorKind(error, failureKind),
      ...(frames.length === 0 ? {} : { frames }),
      ...(causes.length === 0 ? {} : { causeChain: causes }),
    },
    context,
  );
}

// Why a request for a path under Keiko's private managed-workspace root was refused before any
// workspace identity could be examined. A 403 that leaves no line is not reconstructible: an
// unpaired browser tab reading an active managed worktree's editor settings produced exactly that
// (observed live, 2026-09-03).
// A request that names the managed root itself, never a workspace inside it, is not a member: it
// reaches `resolveManagedWorkspaceRootAccess`, which records its own classified denial (#3381).
export type ManagedRootRequestDenialReason =
  // No live launcher-paired app session accompanied the request.
  "managed-root-session-authority-missing";

export function recordManagedRootRequestDenial(
  reason: ManagedRootRequestDenialReason,
  context: WorkspaceRootDenialLogContext,
): void {
  recordWorkspaceRootDenied(
    { reason, failureKind: "DENIED", errorKind: "authority-denied" },
    context,
  );
}

export function resolveRecordedWorkspaceRoot(
  fs: WorkspaceFs,
  lexicalRoot: string,
  context: WorkspaceRootDenialLogContext,
): string {
  try {
    return resolveExistingAllowedWorkspaceRealRoot(fs, lexicalRoot);
  } catch (error) {
    if (error instanceof PathDeniedError) recordWorkspaceRootDenial(error, context);
    throw error;
  }
}
