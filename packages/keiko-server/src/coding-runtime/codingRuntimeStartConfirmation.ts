import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimeSource,
} from "@oscharko-dev/keiko-contracts";

const DIGEST = /^[a-f0-9]{64}$/u;

export interface CodingRuntimeStartConfirmationFacts {
  readonly requestId: string;
  readonly taskIntent: string;
  readonly requestedMode: CodingWorkbenchMode;
  readonly runtimePreference?: CodingWorkbenchRuntimePreference | undefined;
  readonly operatorId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly projectDigest: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly branchRef: string;
  readonly branchHeadDigest: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly modelProfileId: string;
}

export interface CodingRuntimeStartConfirmationClaim {
  readonly requestId: string;
  readonly bindingDigest: string;
  readonly nowMs: number;
}

export interface CodingRuntimeConsumedStartConfirmation {
  readonly approvalDigest: string;
}

/**
 * Server-private adapter seam for the existing central action-confirmation authority. #2377 owns
 * the productive adapter. This issue deliberately provides no issuer or fallback approval store.
 */
export interface CodingRuntimeStartConfirmationConsumer {
  readonly consume: (
    claim: CodingRuntimeStartConfirmationClaim,
  ) => CodingRuntimeConsumedStartConfirmation | undefined;
}

export function codingRuntimeStartConfirmationClaim(
  facts: CodingRuntimeStartConfirmationFacts,
  nowMs: number,
): CodingRuntimeStartConfirmationClaim {
  return {
    requestId: facts.requestId,
    bindingDigest: sha256Hex(
      canonicalise({
        schema: "coding-runtime-start-confirmation-v1",
        requestId: facts.requestId,
        intent: {
          taskIntent: facts.taskIntent,
          requestedMode: facts.requestedMode,
          runtimePreference: facts.runtimePreference,
        },
        operator: facts.operatorId,
        task: facts.taskId,
        project: { id: facts.projectId, digest: facts.projectDigest },
        workspace: { id: facts.workspaceId, rootDigest: sha256Hex(facts.workspaceRoot) },
        branch: { ref: facts.branchRef, headDigest: facts.branchHeadDigest },
        mode: { requested: facts.requestedMode, ceiling: facts.deploymentCeiling },
        runtime: facts.runtimeSource,
        model: { source: facts.modelSource, profileId: facts.modelProfileId },
      }),
    ),
    nowMs,
  };
}

export function isConsumedRuntimeStartConfirmation(
  value: CodingRuntimeConsumedStartConfirmation | undefined,
): value is CodingRuntimeConsumedStartConfirmation {
  return value !== undefined && DIGEST.test(value.approvalDigest);
}
