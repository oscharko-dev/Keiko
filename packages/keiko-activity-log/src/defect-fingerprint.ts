import { createHash } from "node:crypto";
import {
  ACTIVITY_LOG_OPERATION_SURFACES,
  activityLogErrorKindOr,
  defectFingerprintPreimage,
  type DefectFingerprintInput,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
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
