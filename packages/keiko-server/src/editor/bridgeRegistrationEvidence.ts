import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { EditorAgentRootBoundaryReason, ReplacedRootRefresh } from "./agentRootBoundary.js";

export type EditorBridgeRegistrationOutcome =
  "registered" | "refreshed" | "rotated" | "refused" | "identity-refreshed";
/** Why a registration was refused: a root-boundary reason, or the run's lease held elsewhere. */
export type EditorBridgeRegistrationRefusal = EditorAgentRootBoundaryReason | "capability-held";

// #4117: a Coding Workbench bridge registration the server refused was visible only as an opaque
// 403 on the request line, so the log could not say which of the boundary or lease checks refused.
const EDITOR_BRIDGE_REGISTRATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.agent.bridge-registration",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.bridgeRegistrationEvidence.recordBridgeRegistration",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["registered", "refreshed", "rotated", "refused", "identity-refreshed"],
    },
    // #4117: set only on `identity-refreshed`, the manifest revisions around the adoption of a
    // folder replaced at the same path. Counts only; the digests and the path stay out of the log.
    previousManifestRevision: { type: "integer", dataClass: "count", required: false },
    manifestRevision: { type: "integer", dataClass: "count", required: false },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "root-binding-required",
        "root-binding-invalid",
        "decompose-per-root",
        "workspace-boundary-escape",
        "capability-held",
      ],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["editor-bridge-registration"],
  proofIds: ["editor.agent.bridge-registration.lifecycle"],
  releaseImpact: "patch",
});

export function recordBridgeRegistration(
  outcome: EditorBridgeRegistrationOutcome,
  correlationId: string | undefined,
  reason?: EditorBridgeRegistrationRefusal,
  refresh?: ReplacedRootRefresh,
): void {
  const refused = outcome === "refused";
  processServerLogSink().write(
    activityLogEvent(
      EDITOR_BRIDGE_REGISTRATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        level: refused ? "warn" : "info",
        ...(refused
          ? ({
              errorKind: reason === "capability-held" ? "conflict" : "authority-denied",
            } as const)
          : {}),
      },
      {
        outcome,
        ...(reason === undefined ? {} : { reason }),
        ...(refresh === undefined
          ? {}
          : {
              previousManifestRevision: refresh.previousRevision,
              manifestRevision: refresh.revision,
            }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
