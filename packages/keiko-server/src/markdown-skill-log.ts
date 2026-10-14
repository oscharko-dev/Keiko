import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";

const MARKDOWN_SKILL_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "skills.library.operation",
  category: "setup",
  owner: "keiko-server",
  emitter: "markdown-skill-log.logMarkdownSkillOperation",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "list",
        "read",
        "import",
        "replace",
        "delete",
        "export",
        "selection-read",
        "selection-change",
      ],
    },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["started", "completed", "rejected", "failed"],
    },
    httpStatus: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["markdown-skill-library"],
  proofIds: ["skills.library.operation.lifecycle"],
  releaseImpact: "minor",
});

export type MarkdownSkillAction =
  | "list"
  | "read"
  | "import"
  | "replace"
  | "delete"
  | "export"
  | "selection-read"
  | "selection-change";

export function logMarkdownSkillOperation(
  correlationId: string | undefined,
  action: MarkdownSkillAction,
  phase: "started" | "completed" | "rejected" | "failed",
  status: number,
): void {
  processServerLogSink().write(
    activityLogEvent(
      MARKDOWN_SKILL_OPERATION,
      { correlationId: correlationId ?? UNKNOWN_CORRELATION_ID },
      { action, phase, httpStatus: status, completeness: "complete", loss: "none" },
    ),
  );
}
