// The activity-log line for an interactive commit that was refused or failed on the bound lane. One
// closed cause says why nothing (or not the expected thing) was written; when a throw ended it the
// line also carries the structured error class, frames and cause chain. No message, path, ref name
// or object id leaves the process (AGENTS.md section 8).
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  causeChain,
  errorKindOf,
  keikoStackFrames,
  type ServerLogSink,
} from "@oscharko-dev/keiko-activity-log";
import type { GitCommitRefusedReport } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { correlationIdOrUnknown } from "../correlation.js";

export const GIT_COMMIT_REFUSAL_CAUSE_VALUES = [
  "not-on-prepared-branch",
  "authority-lapsed",
  "sequencer-in-progress",
  "sequencer-unreadable",
  "empty-message",
  "message-invalid",
  "message-too-large",
  "cleanup-unavailable",
  "landed-after-failure",
  "nothing-to-commit",
  "ref-moved",
  "checkout-unreadable",
  "revision-unreadable",
  "git-command-failed",
  "interrupted",
  "unexpected-error",
] as const;

const COMMIT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.commit-refused",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "gitDelivery/commitRefusalLog.logGitCommitRefused",
  fields: {
    refusal: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...GIT_COMMIT_REFUSAL_CAUSE_VALUES],
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
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["git-delivery-precondition"],
  proofIds: ["git.delivery.commit-refused.emitted-line"],
  releaseImpact: "patch",
});

// A refusal without an error is a statement about the repository or the request; its kind follows
// the cause. A cause that ended in a throw takes the kind of that throw.
const REFUSAL_ERROR_KIND: Readonly<Record<string, ActivityLogErrorKind>> = {
  "not-on-prepared-branch": "conflict",
  "authority-lapsed": "authority-denied",
  "sequencer-in-progress": "conflict",
  "sequencer-unreadable": "unavailable",
  "empty-message": "validation-failed",
  "message-invalid": "validation-failed",
  "message-too-large": "validation-failed",
  "nothing-to-commit": "validation-failed",
  "ref-moved": "conflict",
  "checkout-unreadable": "read-failed",
  "cleanup-unavailable": "unavailable",
  "landed-after-failure": "durability-failed",
  "revision-unreadable": "read-failed",
};

function refusalErrorKind(report: GitCommitRefusedReport): ActivityLogErrorKind {
  const fixed = REFUSAL_ERROR_KIND[report.cause];
  if (fixed !== undefined) return fixed;
  const kind = errorKindOf(report.error);
  return kind === "timeout" || kind === "cancelled" ? kind : "internal";
}

/** Records one refused or failed interactive commit on the mutation's correlation. */
export function logGitCommitRefused(
  log: ServerLogSink,
  report: GitCommitRefusedReport,
  correlationId: string | undefined,
): void {
  const errorKind = refusalErrorKind(report);
  const structured = report.error !== undefined;
  const frames = structured ? keikoStackFrames(report.error) : [];
  const chain = structured ? causeChain(report.error) : [];
  log.write(
    activityLogEvent(
      COMMIT_REFUSED_OPERATION,
      {
        level: structured ? "error" : "warn",
        correlationId: correlationIdOrUnknown(correlationId),
        errorKind,
      },
      {
        refusal: report.cause,
        failureKind: structured ? errorKindOf(report.error) : errorKind,
        ...(frames.length > 0 ? { frames } : {}),
        ...(chain.length > 0 ? { causeChain: chain } : {}),
      },
    ),
  );
}
