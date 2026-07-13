import { createHash } from "node:crypto";

export type DebugActivationEvidenceAction = "activate" | "deactivate" | "revoke";
export type DebugActivationEvidenceOutcome = "accepted" | "noOp" | "denied";

/**
 * Content-free activation audit payload. It records a derived decision, never a second opt-in,
 * adapter path, environment value, session transcript, or program output (ADR-0134 D7/D9).
 */
export interface DebugActivationEvidence {
  readonly schemaVersion: "1";
  readonly action: DebugActivationEvidenceAction;
  readonly outcome: DebugActivationEvidenceOutcome;
  readonly priorState: string;
  readonly effectiveState: string;
  readonly reasonCode: string;
  readonly revision: number;
  readonly timestampMs: number;
  readonly policyResult: "allowed" | "denied";
}

export function debugActivationWorkspaceFingerprint(realRoot: string): string {
  return createHash("sha256").update(realRoot, "utf8").digest("hex");
}
