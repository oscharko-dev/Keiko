// Public barrel for the Quality Intelligence workflow execution surface (Epic #270, Issue #273,
// ADR-0023 D6). Re-exports the descriptors, the typed run entries, the cancellation adapter,
// and the helper types callers need to construct inputs. The package barrel re-exports this
// directory under the `QualityIntelligence` namespace.

export {
  QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR,
  QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR,
  QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
  QI_VALIDATION_WORKFLOW_DESCRIPTOR,
  QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS,
  QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS,
  findQualityIntelligenceWorkflowDescriptor,
} from "./descriptors.js";
export type {
  QualityIntelligenceWorkflowDescriptor,
  QualityIntelligenceWorkflowId,
  QualityIntelligenceWorkflowLimits,
} from "./descriptors.js";

export { composeStageCancellation, isCancelled } from "./cancellation.js";
export type { QualityIntelligenceStageCancellationHandle } from "./cancellation.js";

export {
  runQualityIntelligenceArtifactRefinement,
  runQualityIntelligenceCoverageReview,
  runQualityIntelligenceTestDesign,
  runQualityIntelligenceValidation,
} from "./runEntries.js";
export type {
  QualityIntelligenceArtifactRefinementInput,
  QualityIntelligenceClock,
  QualityIntelligenceCoverageReviewInput,
  QualityIntelligenceDispatchPort,
  QualityIntelligenceModelRoutedDeps,
  QualityIntelligenceProvenanceRefs,
  QualityIntelligenceRunEntryDeps,
  QualityIntelligenceRunEventSink,
  QualityIntelligenceRunStatus,
  QualityIntelligenceRunSummary,
  QualityIntelligenceTestDesignInput,
  QualityIntelligenceValidationInput,
} from "./runEntries.js";

// Model-routed (live LLM) test-design entry (Issue #272/#273/#279).
export {
  excerptsByAtomId,
  runQualityIntelligenceModelRoutedTestDesign,
} from "./modelRoutedTestDesign.js";
// Scoped regeneration entry (Epic #735, Issue #743).
export { runScopedRegeneration } from "./scopedRegeneration.js";
export type { ScopedRegenerationInput, ScopedRegenerationResult } from "./scopedRegeneration.js";
export type {
  QualityIntelligenceCandidatesSink,
  QualityIntelligenceGenerationPort,
  QualityIntelligenceGenerationPortArgs,
  QualityIntelligenceGenerationPortResult,
  QualityIntelligenceIngestedAtom,
  QualityIntelligenceModelRoutedTestDesignDeps,
  QualityIntelligenceModelRoutedTestDesignInput,
} from "./modelRoutedTestDesign.js";
