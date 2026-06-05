// Public barrel for @oscharko-dev/keiko-quality-intelligence (Epic #270, Issue #272).
//
// Pure-domain package: no IO, no provider SDK, no UI, no BFF, no scheduler, no event bus,
// no direct model calls. Consumes contracts via the @oscharko-dev/keiko-contracts barrel
// and redaction/hashing primitives via @oscharko-dev/keiko-security only.

export { deriveIntent } from "./domain/intentDerivation.js";
export type { IntentSummary } from "./domain/intentDerivation.js";

export { designTestCaseCandidates } from "./domain/testDesignModel.js";
export type { DesignTestCaseCandidatesInput } from "./domain/testDesignModel.js";

export { buildCoverageMap } from "./domain/coverageRelevance.js";
export type { BuildCoverageMapInput } from "./domain/coverageRelevance.js";

export {
  computeCandidateEquivalenceSignature,
  deduplicateCandidates,
} from "./domain/deduplication.js";

export { validateCandidates } from "./domain/validation.js";

export {
  ALL_POLICY_PROFILES,
  bankingDefault,
  insuranceDefault,
  regressionDefault,
} from "./domain/policyProfile.js";
export type { PolicyProfile } from "./domain/policyProfile.js";

export {
  canonicaliseFragmentList,
  isKnownPriority,
  isMeaningfulText,
  normaliseText,
} from "./domain/assertions.js";

// ─── Ingestion sub-namespace (Issue #278) ──────────────────────────────────────
// Pure-domain ingestion modelling: ADF parsing, untrusted-content normalisation,
// source-mix planning, source reconciliation. No IO; consumes contract types only.
export * as QualityIntelligenceIngestion from "./ingestion/index.js";
