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

export function recordRelocatedWorkspaceRootDenial(
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
    op: "workspace.root-relocation.denied",
    correlationId: correlationIdOrUnknown(context.correlationId),
    errorKind: error.code,
    extra: {
      decision: "denied",
      reason: "relocated-denied-locus",
      ...(frames.length === 0 ? {} : { frames }),
      ...(causes.length === 0 ? {} : { causeChain: causes }),
    },
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
    if (error instanceof PathDeniedError) recordRelocatedWorkspaceRootDenial(error, context);
    throw error;
  }
}
