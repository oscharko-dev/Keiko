// Public barrel for the verification orchestrator layer (ADR-0007 / ADR-0019). Verification reuses
// the keiko-tools command boundary unchanged; this layer adds plan construction, per-command
// resource limits, best-effort memory monitoring, classified+redacted evidence, and audit/CLI/
// Markdown surfaces. Explicit named re-exports, `type` keyword for type-only, double quotes, `.js`.
//
// Asymmetric-surface invariant: package internals that were NOT in the pre-move
// src/verification/index.ts (notably `VERIFICATION_COMMAND_RULES` in orchestrator.ts) stay OFF
// the barrel — consumers either re-host the constant inside the package's own tests via the
// relative path, or compose runVerification, which already wires the rule set. Mirrors the
// keiko-tools (Browser CDP) and keiko-workspace (`nodeWorkspaceFs`) asymmetry pattern.

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
} from "./types.js";

export { DEFAULT_VERIFICATION_LIMITS } from "./types.js";

export { VERIFICATION_CODES, VerificationError, EmptyPlanError } from "./errors.js";
export type { VerificationCode } from "./errors.js";

export { classifyScripts, detectScripts } from "./detect.js";

export { classifyOutcome } from "./classify.js";
export type { AbortReason, OutcomeInput } from "./classify.js";

export { buildVerificationPlan, resolveTargetedTests } from "./plan.js";
export type { PlanOptions } from "./plan.js";

export { nodeResourceMonitor } from "./monitor.js";
export type { ResourceMonitor } from "./monitor.js";

export { buildAppliedLimits } from "./limits.js";
export type { BreachedDimension } from "./limits.js";

export { runVerification } from "./orchestrator.js";
export type { VerificationDeps } from "./orchestrator.js";

export { buildVerificationSummary, renderMarkdownSummary, summarizeForAudit } from "./summary.js";
export type {
  AuditResultEntry,
  VerificationAuditSummary,
  VerificationResultSummary,
  VerificationSummary,
} from "./summary.js";
