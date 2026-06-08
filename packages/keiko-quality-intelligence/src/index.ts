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
