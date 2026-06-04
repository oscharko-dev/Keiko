// Public surface of @oscharko-dev/keiko-memory-consolidation (Epic #204 child #208).
// Keeping this file the SOLE entry point prevents downstream packages from reaching into
// private modules (ADR-0019 trust rule 7). Internal modules (dedupe, stale, conflicts,
// similarity, _ordering, _constants) are package-private.
//
// Bootstrap surface only — runtime exports land in subsequent tasks (#208 M3..M8). The shape of
// the surface is pinned here so the package compiles and the version smoke-test runs.

export { KEIKO_MEMORY_CONSOLIDATION_VERSION } from "./version.js";
export type {
  ConsolidationJob,
  ConsolidationJobState,
  ConsolidationOptions,
  ConsolidationResult,
  ProposedAction,
  ReviewItem,
  ReviewReason,
  StaleFlag,
  StaleReason,
} from "./types.js";
