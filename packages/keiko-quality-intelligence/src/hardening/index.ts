// Quality Intelligence — hardening sub-namespace barrel (Epic #270, Issue #284).
//
// Pure adversarial-input predicates and oversize guards. Re-exported from the
// package barrel under the `QualityIntelligenceHardening` namespace so the
// existing public surface is not polluted at the top level.

export { isSafeRelativePath, MAX_SAFE_RELATIVE_PATH_LENGTH } from "./pathSafety.js";

export {
  assertCandidateCount,
  assertPromptSize,
  assertSourceSize,
  MAX_CANDIDATES_PER_RUN,
  MAX_PROMPT_BYTES,
  MAX_SOURCE_BYTES,
} from "./oversizeGuards.js";
export type { OversizeGuardOutcome } from "./oversizeGuards.js";

export { PROMPT_INJECTION_PATTERN_COUNT, scanForPromptInjections } from "./promptInjectionScrub.js";
export type { PromptInjectionScanResult } from "./promptInjectionScrub.js";
