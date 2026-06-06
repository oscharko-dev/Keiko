// Single-sourced package version; CLI and SDK both read this to avoid drift.
export const SDK_VERSION = "0.1.7";
// The typed agent surface. AgentConfig, the session factory, the run result, and the
// session handle all live in the harness module (ADR-0004); the SDK re-exports them so
// callers import the agent API from one place.
export { createSession, } from "../harness/index.js";
export { runAgent } from "./run-agent.js";
// Safe workspace context surface (ADR-0005). The only file-read path is the
// boundary-checked one; no export returns raw arbitrary file content.
export { buildWorkspaceSummary, detectWorkspace, summarizeForAudit, } from "../workspace/index.js";
// Verification orchestrator surface (ADR-0007). Verification reuses the #6 command boundary
// unchanged; these are the plan/run/summary entry points and their JSON-serializable shapes
// (the stable contract the #10 audit ledger persists). The audit projection is exposed under an
// explicit alias because the workspace surface already owns `summarizeForAudit`.
export { buildVerificationPlan, buildVerificationSummary, classifyOutcome, detectScripts, renderMarkdownSummary, resolveTargetedTests, runVerification, summarizeForAudit as summarizeVerificationForAudit, DEFAULT_VERIFICATION_LIMITS, } from "@oscharko-dev/keiko-verification";
// Reviewable developer-assist workflows (ADR-0008). The unit-test generation workflow is the first
// programmatic workflow surface: generateUnitTests is the single entry, the descriptor lets a UI
// (#13) render the workflow without the implementation, and the WorkflowEvent union plus report
// types are the stable contract the #10 audit ledger persists.
export { generateUnitTests, renderMarkdownReport, UNIT_TEST_WORKFLOW_DESCRIPTOR, DEFAULT_WORKFLOW_LIMITS, detectConventions, isTestPath, } from "../workflows/index.js";
// Bug-investigation workflow (ADR-0009). The second programmatic workflow surface: investigateBug
// is the single entry, BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR lets a UI (#13) render it without the
// implementation, and the BugInvestigationReport (with its structural verified/hypothesis split)
// plus the BugInvestigationEvent union are the stable contract the #10 audit ledger persists. The
// Markdown renderer is aliased to avoid colliding with the unit-test workflow's renderMarkdownReport.
export { investigateBug, renderBugMarkdownReport as renderBugInvestigationReport, BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR, DEFAULT_BUG_WORKFLOW_LIMITS, isSensitivePath, isElevatedReviewPath, parseFailureEvidence, } from "../workflows/index.js";
// Audit ledger / evidence manifests (ADR-0010). The first persistent-artifact surface: persistEvidence
// builds → redacts-by-construction → writes a redacted, versioned EvidenceManifest, and listEvidence /
// loadEvidence are the #13 UI seam. Exported via an explicit named block (not `export *`) to keep the
// surface auditable; none of these names collides with an existing layer export (the layer does NOT
// export a bare `summarizeForAudit` or `redact` — it composes them internally).
export { buildEvidenceManifest, persistEvidence, createAuditRedactor, createNodeEvidenceStore, createInMemoryEvidenceStore, aggregateUsage, listEvidence, loadEvidence, applyRetention, buildEvidenceReport, renderEvidenceReport, assertValidRunId, EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION, } from "../audit/index.js";
// Cost-class resolver (relocated to the model gateway in issue #163 so the evidence package stays
// leaf-clean against ADR-0019 rule 3d). Re-exported on the SDK surface here to preserve the
// pre-#163 public API for downstream callers that imported `resolveCostClass` from "keiko".
export { resolveCostClass } from "../gateway/index.js";
// Wave 1 evaluation harness (ADR-0012 D11). The deterministic offline runner, the product-code
// scripted-model replay port, and the versioned scorecard schema, exported via an explicit named
// block (no `export *`). ScriptedModelPort is surfaced so external callers can build replay tooling
// without the full runner. No name collides with an existing SDK export.
export { runEvaluationSuite, createScriptedModelPort, EVAL_SCORECARD_SCHEMA_VERSION, } from "../evaluations/index.js";
