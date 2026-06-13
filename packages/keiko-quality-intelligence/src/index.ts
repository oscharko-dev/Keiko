// Public barrel for @oscharko-dev/keiko-quality-intelligence (Epic #270, Issue #272).
//
// Pure-domain package: no IO, no provider SDK, no UI, no BFF, no scheduler, no event bus,
// no direct model calls. Consumes contracts via the @oscharko-dev/keiko-contracts barrel
// and redaction/hashing primitives via @oscharko-dev/keiko-security only.

// ─── Staleness / drift detection (Epic #735, Issue #742) ──────────────────────
export { compareStaleness } from "./domain/staleness.js";
export type { StalenessReason, StalenessResult } from "./domain/staleness.js";

export { deriveIntent } from "./domain/intentDerivation.js";
export type { IntentSummary } from "./domain/intentDerivation.js";

export { designTestCaseCandidates } from "./domain/testDesignModel.js";
export type { DesignTestCaseCandidatesInput } from "./domain/testDesignModel.js";

export {
  buildAtomCoverageStatuses,
  buildCoverageMap,
  classifyAtomCoverage,
  COVERAGE_THRESHOLD_COVERED,
  COVERAGE_THRESHOLD_WEAKLY_COVERED,
  runCoveragePercentage,
} from "./domain/coverageRelevance.js";
export type {
  AtomCoverageStatus,
  BuildCoverageMapInput,
  CoverageStatus,
} from "./domain/coverageRelevance.js";

export {
  buildRequirementExcerpt,
  REQUIREMENT_EXCERPT_MAX_CHARS,
} from "./domain/requirementExcerpt.js";

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
  normaliseCandidateText,
  normaliseText,
} from "./domain/assertions.js";

export {
  TEST_QUALITY_WEAK_THRESHOLD,
  scoreFromDimensions,
  verdictFromScore,
} from "./domain/testQualityRubric.js";

// ─── Ingestion sub-namespace (Issue #278) ──────────────────────────────────────
// Pure-domain ingestion modelling: ADF parsing, untrusted-content normalisation,
// source-mix planning, source reconciliation. No IO; consumes contract types only.
export * as QualityIntelligenceIngestion from "./ingestion/index.js";

// ─── Review sub-namespace (Issue #282) ─────────────────────────────────────────
// Pure-domain review governance: state machine, lifecycle policy, four-eyes
// pairing guard, and the producer half of the audit-event envelope. No IO, no
// persistence; consumes contract types only.
export * as QualityIntelligenceReview from "./review/index.js";

// ─── Hardening sub-namespace (Issue #284) ──────────────────────────────────────
// Pure adversarial-input predicates: path-safety, oversize guards, prompt-injection
// scrubber. No IO; layered defence beside `QualityIntelligenceIngestion`.
export * as QualityIntelligenceHardening from "./hardening/index.js";

// ─── Export sub-namespace (Issue #283) ─────────────────────────────────────────
// Pure-domain export adapters (CSV / JSON / TMS mappings) + bundle serialiser. No IO; the
// server tier owns persistence + connector authorisation. TMS-targeted bundles must attest
// redaction (enforced by the contract invariant).
export * as QualityIntelligenceExport from "./export/index.js";

// ─── Generation sub-namespace (Issue #272/#278/#279) ───────────────────────────
// Pure model-routed generation prep + recovery: trusted prompt assembly, requirements-text
// ingestion into content-bearing atoms, and deterministic model-output → candidate parsing.
// No IO, no model call; the server tier supplies the Keiko Model Gateway port.
export * as QualityIntelligenceGeneration from "./generation/index.js";

// ─── Figma Screen-IR sub-namespace (Epic #750, Issue #752) ─────────────────────
// Pure-domain Figma cleaner: raw scoped node tree → lean per-screen IR + deduped design tokens +
// raw inter-screen links + reduction report. No IO, no network, no model. Downstream stages
// (#753 evidence, #754 QI source, #811 nav graph, #812 a11y, #755 codegen) import from here.
export * as QualityIntelligenceFigma from "./domain/figma/index.js";
