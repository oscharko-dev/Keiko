import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceEvidenceManifest,
  QualityIntelligenceExportPolicyProvenance,
} from "@oscharko-dev/keiko-evidence";

const UNKNOWN_MODEL_METADATA = "unknown";

function modelStage(modelId: string | undefined): QI.QualityIntelligenceExportModelStageProvenance {
  return {
    modelId: modelId?.trim() ? modelId : UNKNOWN_MODEL_METADATA,
    provider: UNKNOWN_MODEL_METADATA,
    revision: UNKNOWN_MODEL_METADATA,
  };
}

export interface QualityIntelligenceExportProvenance {
  readonly model: QI.QualityIntelligenceExportModelProvenance;
  readonly policy: QualityIntelligenceExportPolicyProvenance;
}

/**
 * Build the single body-free provenance projection used by every QI export route.
 *
 * The manifest is already persist-redacted. This projection carries only model ids, safe scalar
 * parameters, policy ids, and the deterministic seed; never candidate or source bodies.
 */
// eslint-disable-next-line complexity
export function buildQualityIntelligenceExportProvenance(
  manifest: QualityIntelligenceEvidenceManifest,
): QualityIntelligenceExportProvenance {
  const generationModelId =
    manifest.modelRouting?.resolved.testDesignModelId ??
    manifest.modelRouting?.preflight.generation?.modelId ??
    manifest.modelId;
  const judgeModelId =
    manifest.modelRouting?.resolved.judgeModelId ?? manifest.modelRouting?.preflight.judge?.modelId;
  return {
    model: {
      generation: modelStage(generationModelId),
      judge: modelStage(judgeModelId),
      // KEIKO-0603: seedUsed is now required (number | null) on the export contract, following the
      // completedAt precedent -- null means no seed was used or recorded, collapsing the manifest's
      // separate absent/null tri-state into the wire's two-state contract at this projection.
      seedUsed: manifest.seedUsed ?? null,
      ...(manifest.modelParameters !== undefined
        ? { modelParameters: manifest.modelParameters }
        : {}),
    },
    policy: {
      retentionPolicyId: manifest.retentionPolicyId,
      policyProfileIds: [...manifest.policyProfileIds],
    },
  };
}
