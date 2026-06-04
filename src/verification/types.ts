// Re-export shim: verification contract types and the frozen DEFAULT_VERIFICATION_LIMITS table
// live in @oscharko-dev/keiko-contracts (issue #158). `verbatimModuleSyntax` is on, so type-only
// names use `export type` and value-emitting frozen tables use `export`.

export type {
  VerificationKind,
  VerificationStatus,
  ResourceDimension,
  ResourceLimitDecision,
  VerificationResourceLimits,
  VerificationStep,
  VerificationPlan,
  VerificationResult,
  VerificationReport,
  ScriptCatalog,
  ScriptMapping,
} from "@oscharko-dev/keiko-contracts";
export { DEFAULT_VERIFICATION_LIMITS } from "@oscharko-dev/keiko-contracts";
