import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "../observability/server-log.js";

const DRAFT_RELATED_ISSUES_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.draft-related-issues",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/draftRelatedIssuesActivity.logDraftRelatedIssues",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["resolved", "unavailable"],
    },
    count: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
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
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-draft-related-issues"],
  proofIds: ["git.draft-related-issues.emitted-line"],
  releaseImpact: "patch",
});

interface DraftRelatedIssuesBase {
  readonly correlationId: string;
  readonly runId: string;
  readonly count: number;
}

interface DraftRelatedIssuesResolved extends DraftRelatedIssuesBase {
  readonly state: "resolved";
}

interface DraftRelatedIssuesUnavailable extends DraftRelatedIssuesBase {
  readonly state: "unavailable";
  readonly errorKind: ActivityLogErrorKind;
  readonly failureKind?: string | undefined;
  readonly errorClass?: string | undefined;
  readonly code?: string | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
}

export type DraftRelatedIssuesActivity = DraftRelatedIssuesResolved | DraftRelatedIssuesUnavailable;

export function logDraftRelatedIssues(
  log: ServerLogSink,
  activity: DraftRelatedIssuesActivity,
): void {
  const envelope =
    activity.state === "resolved"
      ? { correlationId: activity.correlationId }
      : {
          correlationId: activity.correlationId,
          level: "warn" as const,
          errorKind: activity.errorKind,
        };
  const failure =
    activity.state === "resolved"
      ? {}
      : {
          ...(activity.failureKind === undefined ? {} : { failureKind: activity.failureKind }),
          ...(activity.errorClass === undefined ? {} : { errorClass: activity.errorClass }),
          ...(activity.code === undefined ? {} : { code: activity.code }),
          ...(activity.frames === undefined ? {} : { frames: activity.frames }),
          ...(activity.causeChain === undefined ? {} : { causeChain: activity.causeChain }),
        };
  log.write(
    activityLogEvent(DRAFT_RELATED_ISSUES_OPERATION, envelope, {
      runId: activity.runId,
      state: activity.state,
      count: activity.count,
      ...failure,
    }),
  );
}
