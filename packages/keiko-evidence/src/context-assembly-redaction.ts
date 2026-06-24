// Field-level redaction for ContextAssemblyDiagnostics (ADR-0056 D4, Layer 1). The diagnostics are
// mostly numeric counts; the only string surfaces that can carry a path or secret are the profile's
// tokenEstimatorId + optional model metadata and each lane's optional compactionReason. The
// per-lane provenanceCounts keys are also string-typed, so they pass through the redactor too.
// This is the construction-time pass; persistConnectedContextEvidence applies deepRedactStrings as
// a second whole-object pass (defense in depth). Pure: no IO, no clock.

import type {
  ContextAssemblyDiagnostics,
  ContextLaneDiagnostics,
  ContextModelMetadata,
  ContextProfile,
} from "@oscharko-dev/keiko-contracts";

type Redactor = (input: string) => string;

function redactModelMetadata(
  model: ContextModelMetadata | undefined,
  redact: Redactor,
): ContextModelMetadata | undefined {
  if (model === undefined) {
    return undefined;
  }
  return {
    ...(model.id === undefined ? {} : { id: redact(model.id) }),
    ...(model.provider === undefined ? {} : { provider: redact(model.provider) }),
    ...(model.notes === undefined ? {} : { notes: redact(model.notes) }),
  };
}

function redactProfile(profile: ContextProfile, redact: Redactor): ContextProfile {
  const model = redactModelMetadata(profile.model, redact);
  return {
    schemaVersion: profile.schemaVersion,
    maxInputTokens: profile.maxInputTokens,
    reservedOutputTokens: profile.reservedOutputTokens,
    safetyMarginTokens: profile.safetyMarginTokens,
    effectiveInputBudget: profile.effectiveInputBudget,
    tokenEstimatorId: redact(profile.tokenEstimatorId),
    ...(model === undefined ? {} : { model }),
  };
}

function redactProvenanceCounts(
  counts: Readonly<Record<string, number>> | undefined,
  redact: Redactor,
): Readonly<Record<string, number>> | undefined {
  if (counts === undefined) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    out[redact(key)] = value;
  }
  return out;
}

function redactLaneDiagnostics(
  lane: ContextLaneDiagnostics,
  redact: Redactor,
): ContextLaneDiagnostics {
  const provenanceCounts = redactProvenanceCounts(lane.provenanceCounts, redact);
  return {
    laneId: lane.laneId,
    estimatedTokens: lane.estimatedTokens,
    includedItems: lane.includedItems,
    excludedItems: lane.excludedItems,
    budgetPressure: lane.budgetPressure,
    ...(lane.compactionReason === undefined
      ? {}
      : { compactionReason: redact(lane.compactionReason) }),
    ...(provenanceCounts === undefined ? {} : { provenanceCounts }),
  };
}

export function redactContextAssemblyDiagnostics(
  diagnostics: ContextAssemblyDiagnostics,
  redact: Redactor,
): ContextAssemblyDiagnostics {
  return {
    schemaVersion: diagnostics.schemaVersion,
    profile: redactProfile(diagnostics.profile, redact),
    totalEstimatedTokens: diagnostics.totalEstimatedTokens,
    budgetPressure: diagnostics.budgetPressure,
    lanes: diagnostics.lanes.map((lane) => redactLaneDiagnostics(lane, redact)),
    orderedForRecency: diagnostics.orderedForRecency,
  };
}
