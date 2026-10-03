import { createHash } from "node:crypto";
import {
  ACTIVITY_LOG_OPERATION_SURFACES,
  MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS,
  activityLogErrorKindOr,
  defectFingerprintPreimage,
  isActivityLogCorrelationId,
  type DefectFingerprintInput,
  type SupportIncidentCorrelation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isRedactedLogLabel } from "./log-redaction.js";
import { FRAME_SHAPE_PATTERN } from "./stack-frames.js";

/**
 * The deterministic, versioned defectFingerprint: SHA-256 over the canonical contract preimage.
 * Shared by the incident store that records it and the report reader that checks it, so neither
 * restates the formula.
 */
export function computeDefectFingerprint(input: DefectFingerprintInput): string {
  return createHash("sha256").update(defectFingerprintPreimage(input), "utf8").digest("hex");
}

/** The facts of one registered failure that its incident identity is derived from. */
export interface RegisteredFailureFacts {
  readonly op: string;
  readonly errorKind?: unknown;
  readonly frames?: unknown;
  readonly correlationId?: unknown;
  readonly parentCorrelationId?: unknown;
}

/**
 * The fingerprint inputs of a registered failure: its operation's owning surface, its closed error
 * kind and its Keiko frames. The incident producer records them and the report reader recomputes
 * them from a retained failing line through these same rules.
 */
export function registeredFailureFingerprintInput(
  failure: RegisteredFailureFacts,
): DefectFingerprintInput {
  const frames = Array.isArray(failure.frames) ? (failure.frames as readonly unknown[]) : [];
  return {
    surface: ACTIVITY_LOG_OPERATION_SURFACES[failure.op] ?? "unattributed",
    op: failure.op,
    errorKind: activityLogErrorKindOr(failure.errorKind, "unknown"),
    frames: frames.filter(
      (frame): frame is string => typeof frame === "string" && FRAME_SHAPE_PATTERN.test(frame),
    ),
  };
}

// A correlation id the writer would redact (a credential-shaped label) never enters an incident:
// the persisted lines carry only its marker, so it could leak a secret but never join evidence.
export function incidentCorrelationId(value: unknown): string | undefined {
  return isActivityLogCorrelationId(value) && isRedactedLogLabel(value) ? value : undefined;
}

/**
 * The correlation a registered failure belongs to: its parent when it was spawned, else its own id,
 * with the spawned operation as the one child. The producer records it and the report reader
 * recomputes it from the retained failing line, so a header names no edge its evidence lacks.
 */
export function registeredFailureCorrelation(
  failure: Pick<RegisteredFailureFacts, "correlationId" | "parentCorrelationId">,
): SupportIncidentCorrelation {
  const own = incidentCorrelationId(failure.correlationId);
  const parent = incidentCorrelationId(failure.parentCorrelationId);
  const root = parent ?? own;
  const children = parent !== undefined && own !== undefined && own !== parent ? [own] : [];
  return {
    ...(root === undefined ? {} : { rootCorrelationId: root }),
    childCorrelationIds: children.slice(0, MAX_SUPPORT_INCIDENT_CHILD_CORRELATIONS),
  };
}
