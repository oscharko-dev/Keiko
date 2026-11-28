// The activity-log line for a Git index transaction (or branch ref lock) whose cleanup could not
// finish. The transaction's own result is already settled and is never replaced; what stayed is a
// leftover private directory or file, or an index/ref lock that would block the next write. Counts
// and flags only: no path, name or message leaves the process (AGENTS.md section 8).
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { correlationIdOrUnknown } from "../correlation.js";

export const GIT_INDEX_CLEANUP_CALLERS = [
  "stage",
  "unstage",
  "branch-ref-lock",
  "turn-index-restore",
] as const;
export type GitIndexCleanupCaller = (typeof GIT_INDEX_CLEANUP_CALLERS)[number];

export interface GitIndexCleanupIncompleteFacts {
  readonly caller: GitIndexCleanupCaller;
  readonly quarantines: number;
  readonly temporaryIndex: boolean;
  readonly lock: boolean;
  readonly refLocks: number;
  readonly directories: number;
}

const CLEANUP_INCOMPLETE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.index-transaction.cleanup-incomplete",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "gitDelivery/indexCleanupLog.logGitIndexCleanupIncomplete",
  fields: {
    caller: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...GIT_INDEX_CLEANUP_CALLERS],
    },
    quarantineFailures: { type: "integer", dataClass: "count", required: true },
    temporaryIndexLeft: { type: "boolean", dataClass: "closed-enum", required: true },
    lockLeft: { type: "boolean", dataClass: "closed-enum", required: true },
    refLockFailures: { type: "integer", dataClass: "count", required: true },
    directoryFailures: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["git-delivery-precondition"],
  proofIds: ["git.index-transaction.cleanup-incomplete.emitted-line"],
  releaseImpact: "patch",
});

/** Records one finished transaction whose cleanup left something behind (never called when clean). */
export function logGitIndexCleanupIncomplete(
  log: ServerLogSink,
  facts: GitIndexCleanupIncompleteFacts,
  correlationId: string | undefined,
): void {
  log.write(
    activityLogEvent(
      CLEANUP_INCOMPLETE_OPERATION,
      {
        level: "warn",
        correlationId: correlationIdOrUnknown(correlationId),
        errorKind: "unavailable",
      },
      {
        caller: facts.caller,
        quarantineFailures: facts.quarantines,
        temporaryIndexLeft: facts.temporaryIndex,
        lockLeft: facts.lock,
        refLockFailures: facts.refLocks,
        directoryFailures: facts.directories,
      },
    ),
  );
}
