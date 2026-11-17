import type { KnowledgeCitationEditorTargetResponse } from "@oscharko-dev/keiko-contracts";
import { KNOWLEDGE_CITATION_EDITOR_TARGET_REASONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-preview";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { getServerLogger } from "./observability/index.js";

const OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "knowledge.citation.editor-target",
  category: "search",
  owner: "keiko-server",
  emitter: "knowledge-citation-editor-activity.logKnowledgeCitationEditorTarget",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["authorized", "rejected"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: KNOWLEDGE_CITATION_EDITOR_TARGET_REASONS,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  diagnosticWhen: [{ field: "outcome", values: ["rejected"] }],
  analyzerProjection: "timeline",
  failureClasses: ["knowledge-citation-editor-target"],
  proofIds: ["knowledge.citation.editor-target.line"],
  releaseImpact: "patch",
});

export function logKnowledgeCitationEditorTarget(
  correlationId: string,
  result: KnowledgeCitationEditorTargetResponse,
): void {
  getServerLogger().info(
    activityLogEvent(
      OPERATION,
      { correlationId },
      {
        outcome: result.outcome,
        ...(result.outcome === "rejected" ? { reason: result.reason } : {}),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
