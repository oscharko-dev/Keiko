import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "../observability/server-log.js";

export const DRAFT_RELATED_ISSUES_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.draft-related-issues",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery.logDraftRelatedIssues",
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

interface DraftRelatedIssuesContext {
  readonly correlationId: string;
  readonly runId: string;
}

type DraftRelatedIssuesOutcome =
  | { readonly state: "resolved"; readonly count: number }
  | {
      readonly state: "unavailable";
      readonly count: number;
      readonly errorKind: ActivityLogErrorKind;
      readonly failureKind?: string;
      readonly errorClass?: string;
      readonly code?: string;
      readonly frames?: readonly string[];
      readonly causeChain?: readonly string[];
    };

export function logDraftRelatedIssues(
  sink: ServerLogSink,
  context: DraftRelatedIssuesContext,
  outcome: DraftRelatedIssuesOutcome,
): void {
  sink.write(
    activityLogEvent(
      DRAFT_RELATED_ISSUES_OPERATION,
      {
        correlationId: context.correlationId,
        ...(outcome.state === "unavailable"
          ? { level: "warn" as const, errorKind: outcome.errorKind }
          : {}),
      },
      {
        runId: context.runId,
        state: outcome.state,
        count: outcome.count,
        ...(outcome.state === "unavailable" && outcome.failureKind !== undefined
          ? { failureKind: outcome.failureKind }
          : {}),
        ...(outcome.state === "unavailable" && outcome.errorClass !== undefined
          ? { errorClass: outcome.errorClass }
          : {}),
        ...(outcome.state === "unavailable" && outcome.code !== undefined
          ? { code: outcome.code }
          : {}),
        ...(outcome.state === "unavailable" && outcome.frames !== undefined
          ? { frames: outcome.frames }
          : {}),
        ...(outcome.state === "unavailable" && outcome.causeChain !== undefined
          ? { causeChain: outcome.causeChain }
          : {}),
      },
    ),
  );
}
