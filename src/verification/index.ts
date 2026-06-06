// Re-export shim: the verification orchestrator layer lives in @oscharko-dev/keiko-verification
// (issue #424, ADR-0019). All existing import sites (`from "../verification/index.js"`) keep
// resolving unchanged via this barrel. Mirrors the tools/workspace/contracts shim conventions:
// explicit named re-exports, `type` keyword for type-only, double quotes, `.js` suffix.
//
// Asymmetric-surface invariant: package internals that were NOT in the pre-move
// src/verification/index.ts (notably `VERIFICATION_COMMAND_RULES`) are deliberately ABSENT
// from this barrel — the one test that used the internal moved into the package and imports
// it via the relative sibling path. Mirrors the keiko-tools (Browser CDP) and keiko-workspace
// (`nodeWorkspaceFs`) asymmetry pattern so a future SDK-leak test can pin this invariant.

export type {
  ResourceDimension,
  ResourceLimitDecision,
  ScriptCatalog,
  ScriptMapping,
  VerificationKind,
  VerificationPlan,
  VerificationReport,
  VerificationResourceLimits,
  VerificationResult,
  VerificationStatus,
  VerificationStep,
} from "@oscharko-dev/keiko-verification";

export { DEFAULT_VERIFICATION_LIMITS } from "@oscharko-dev/keiko-verification";
export {
  VERIFICATION_CODES,
  VerificationError,
  EmptyPlanError,
} from "@oscharko-dev/keiko-verification";
export type { VerificationCode } from "@oscharko-dev/keiko-verification";
export { classifyScripts, detectScripts } from "@oscharko-dev/keiko-verification";
export { classifyOutcome } from "@oscharko-dev/keiko-verification";
export type { AbortReason, OutcomeInput } from "@oscharko-dev/keiko-verification";
export { buildVerificationPlan, resolveTargetedTests } from "@oscharko-dev/keiko-verification";
export type { PlanOptions } from "@oscharko-dev/keiko-verification";
export { nodeResourceMonitor } from "@oscharko-dev/keiko-verification";
export type { ResourceMonitor } from "@oscharko-dev/keiko-verification";
export { buildAppliedLimits } from "@oscharko-dev/keiko-verification";
export type { BreachedDimension } from "@oscharko-dev/keiko-verification";
export { runVerification } from "@oscharko-dev/keiko-verification";
export type { VerificationDeps } from "@oscharko-dev/keiko-verification";
export {
  buildVerificationSummary,
  renderMarkdownSummary,
  summarizeForAudit,
} from "@oscharko-dev/keiko-verification";
export type {
  AuditResultEntry,
  VerificationAuditSummary,
  VerificationResultSummary,
  VerificationSummary,
} from "@oscharko-dev/keiko-verification";
