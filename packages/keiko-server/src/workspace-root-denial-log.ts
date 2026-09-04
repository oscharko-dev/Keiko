import {
  PathDeniedError,
  resolveExistingAllowedWorkspaceRealRoot,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { correlationIdOrUnknown } from "./correlation.js";
import { createServerLogger, type ServerLogSink } from "./observability/index.js";
import { causeChain, keikoStackFrames } from "./observability/stack-frames.js";
import { processServerLogSink } from "./process-log-sink.js";

export interface WorkspaceRootDenialLogContext {
  readonly activityLog?: ServerLogSink | undefined;
  readonly correlationId?: string | undefined;
}

export function recordWorkspaceRootDenial(
  error: PathDeniedError,
  context: WorkspaceRootDenialLogContext,
): void {
  const frames = keikoStackFrames(error);
  const causes = causeChain(error);
  createServerLogger({
    sink: context.activityLog ?? processServerLogSink(),
    level: "debug",
  }).warn({
    category: "security",
    op: "workspace.root.denied",
    correlationId: correlationIdOrUnknown(context.correlationId),
    errorKind: error.code,
    extra: {
      decision: "denied",
      reason: "denied-locus",
      ...(frames.length === 0 ? {} : { frames }),
      ...(causes.length === 0 ? {} : { causeChain: causes }),
    },
  });
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
  createServerLogger({
    sink: context.activityLog ?? processServerLogSink(),
    level: "debug",
  }).warn({
    category: "security",
    op: "workspace.root.denied",
    correlationId: correlationIdOrUnknown(context.correlationId),
    errorKind: "DENIED",
    extra: { decision: "denied", reason },
  });
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
