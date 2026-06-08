// Scoped regeneration entry (Epic #735, Issue #743).
//
// Invokes the existing model-routed test-design workflow with a NARROWED set of ingested atoms
// — only atoms belonging to stale candidates — and a fresh runId. Does NOT re-implement the
// workflow; composes runQualityIntelligenceModelRoutedTestDesign unchanged.

import { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceModelRoutedTestDesignDeps } from "./modelRoutedTestDesign.js";
import { runQualityIntelligenceModelRoutedTestDesign } from "./modelRoutedTestDesign.js";
import type { QualityIntelligenceIngestedAtom } from "./modelRoutedTestDesign.js";
import type {
  QualityIntelligenceRunSummary,
  QualityIntelligenceProvenanceRefs,
} from "./runtimeCommon.js";

const PLAN_STAGES: readonly QI.QualityIntelligenceRunStage[] = Object.freeze([
  { name: "plan", descriptor: "qi:plan" },
  { name: "candidates", descriptor: "qi:model-generate" },
  { name: "judge", descriptor: "qi:judge" },
  { name: "coverage", descriptor: "qi:coverage" },
  { name: "validate", descriptor: "qi:validate" },
  { name: "finalize", descriptor: "qi:finalize" },
]);

export interface ScopedRegenerationInput {
  /** Fresh run id for the regenerated run (must be different from the original). */
  readonly newRunId: string;
  readonly requestedAt: string;
  /** All envelopes from re-ingesting the current sources. */
  readonly envelopes: readonly QI.QualityIntelligenceSourceEnvelope[];
  /** NARROWED to atoms belonging to stale candidates only. */
  readonly ingestedAtoms: readonly QualityIntelligenceIngestedAtom[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
}

export interface ScopedRegenerationResult {
  readonly summary: QualityIntelligenceRunSummary;
  /** Number of atoms that were submitted for regeneration. */
  readonly narrowedAtomCount: number;
}

/**
 * Run the model-routed test-design workflow scoped to a narrowed set of atoms. Returns the full run
 * summary plus a count of narrowed atoms for caller bookkeeping. The caller is responsible for
 * merging the regenerated candidates with preserved-fresh candidates from the original run.
 */
export async function runScopedRegeneration(
  input: ScopedRegenerationInput,
  deps: QualityIntelligenceModelRoutedTestDesignDeps,
): Promise<ScopedRegenerationResult> {
  const plan: QI.QualityIntelligenceRunPlan = {
    id: QI.asQualityIntelligenceRunId(input.newRunId),
    requestedAt: input.requestedAt,
    plannerKind: "model-routed",
    stages: PLAN_STAGES,
  };

  const summary = await runQualityIntelligenceModelRoutedTestDesign(
    {
      plan,
      envelopes: input.envelopes,
      ingestedAtoms: input.ingestedAtoms,
      provenanceRefs: input.provenanceRefs,
    },
    deps,
  );

  return { summary, narrowedAtomCount: input.ingestedAtoms.length };
}
