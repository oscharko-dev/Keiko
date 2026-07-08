// Public surface of @oscharko-dev/keiko-memory-consolidation (Epic #204 child #208).
// Keeping this file the SOLE entry point prevents downstream packages from reaching into
// private modules (ADR-0019 trust rule 7). Internal modules (dedupe, stale, conflicts,
// similarity, _ordering, _constants) are package-private.

export { KEIKO_MEMORY_CONSOLIDATION_VERSION } from "./version.js";
export type {
  ConsolidationJob,
  ConsolidationJobState,
  ConsolidationAccessStat,
  ConsolidationEmbedding,
  ConsolidationEvidence,
  ConsolidationEvidenceKind,
  ConsolidationOptions,
  ConsolidationResult,
  ConsolidationSummaryGenerator,
  ConsolidationSummaryInput,
  ConsolidationSummaryOutput,
  ConsolidationSummaryStatus,
  ProposedAction,
  ReviewItem,
  ReviewItemSuggestedResolution,
  ReviewReason,
  StaleFlag,
  StaleReason,
} from "./types.js";
export { runConsolidation } from "./consolidate.js";
export {
  buildConsolidationJob,
  ConsolidationJobError,
  transitionJob,
  type ConsolidationJobErrorCode,
} from "./job.js";
