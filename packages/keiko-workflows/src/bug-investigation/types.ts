// All interfaces, type aliases, and frozen constant tables for the bug-investigation workflow
// (ADR-0009 D2/D3/D4/D7/D13). No runtime logic beyond the frozen tables. `readonly` everywhere;
// optional props are `| undefined` because exactOptionalPropertyTypes is on. Every report shape is
// plain JSON-serializable so the #10 audit ledger can persist it. Names are DISTINCT from the
// unit-test workflow's (ADR-0009 D5) because both barrels are re-exported from the package root.

import type { MemoryWorkflowPort } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { PatchChangeKind, SpawnFn, WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { VerificationAuditSummary } from "@oscharko-dev/keiko-verification";
import type { BugWorkflowEventSink } from "./events.js";

// ─── Status (D4) ─────────────────────────────────────────────────────────────────

// BugWorkflowStatus, BugWorkflowLimits, and DEFAULT_BUG_WORKFLOW_LIMITS were extracted to
// @oscharko-dev/keiko-contracts in issue #158. Re-exported here so consumers of "./types.js"
// continue to resolve them unchanged.
import type { BugWorkflowLimits, BugWorkflowStatus } from "@oscharko-dev/keiko-contracts";

export type { BugWorkflowStatus, BugWorkflowLimits } from "@oscharko-dev/keiko-contracts";
export { DEFAULT_BUG_WORKFLOW_LIMITS } from "@oscharko-dev/keiko-contracts";

// ─── Failure evidence (D7) ──────────────────────────────────────────────────────────

export interface FailureFrame {
  // Workspace-relative (or as-parsed) file path extracted from the failure output. Redacted in report.
  readonly file: string;
  readonly line?: number | undefined;
}

export interface FailureEvidence {
  // Candidate source locations parsed from the output/stack (deduped, capped). Verified facts.
  readonly frames: readonly FailureFrame[];
  // Short assertion / error messages. Capped; redacted at the report boundary.
  readonly messages: readonly string[];
}

// ─── Input & deps (D2) ─────────────────────────────────────────────────────────────

export interface BugReportInput {
  // Free-text description of the observed bug. At least ONE evidence field must be present.
  readonly description?: string | undefined;
  // Raw failing command / test-runner output (vitest/jest/node). Read from a file by the CLI.
  readonly failingOutput?: string | undefined;
  // A stack trace, if available separately from failingOutput.
  readonly stackTrace?: string | undefined;
  // Suspected target files (workspace-relative), if the developer already has a lead.
  readonly targetFiles?: readonly string[] | undefined;
}

export interface BugInvestigationInput {
  // The workspace root (absolute path).
  readonly workspaceRoot: string;
  readonly report: BugReportInput;
  // When true, a validated in-scope patch is written to disk and verification runs. When false
  // (default), only the diff preview + report are produced. FAIL-CLOSED via #6 applyEnabled.
  readonly apply?: boolean | undefined;
  // Model ID to use (must be registered in the gateway config).
  readonly modelId: string;
  // Per-workflow resource limits. Defaults to DEFAULT_BUG_WORKFLOW_LIMITS.
  readonly limits?: Partial<BugWorkflowLimits> | undefined;
}

export interface BugInvestigationDeps {
  // The model port to use for the investigation call. Injected; mocked in tests.
  readonly model: ModelPort;
  // Workspace filesystem. Defaults to nodeWorkspaceFs.
  readonly fs?: WorkspaceFs | undefined;
  // Filesystem WRITE port used by applyPatch in apply mode. Defaults to nodeWorkspaceWriter.
  readonly writer?: WorkspaceWriter | undefined;
  // Spawn function for runVerification. Defaults to nodeSpawnFn.
  readonly spawn?: SpawnFn | undefined;
  // Monotonic clock. Defaults to Date.now.
  readonly now?: (() => number) | undefined;
  // Unique ID source for event runId. Defaults to crypto.randomUUID.
  readonly idSource?: (() => string) | undefined;
  // Event sink for workflow progress events. No-op by default.
  readonly sink?: BugWorkflowEventSink | undefined;
  // Process environment for runCommand env isolation. Defaults to process.env.
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  // AbortSignal for cancellation.
  readonly signal?: AbortSignal | undefined;
  // Optional Governed Enterprise Memory Vault port (Issue #213). When provided, the workflow
  // composes a scoped memory context block into the prompt and emits memory lifecycle events.
  // Read-only — the port cannot bypass the existing apply gates / scope guard / patch limits.
  readonly memoryPort?: MemoryWorkflowPort | undefined;
}

// ─── Report (D3) ─────────────────────────────────────────────────────────────────

// Facts the workflow itself established — NOT model claims.
export interface VerifiedFindings {
  // Did the proposed patch pass #6 validatePatch AND the scope guard?
  readonly patchValidates: boolean;
  // Was the patch actually written to disk (apply mode only)?
  readonly patchApplied: boolean;
  // Post-apply verification audit summary (output-text-free). Present only when verification ran.
  readonly verification?: VerificationAuditSummary | undefined;
  // Frames the TOOL parsed from the failure evidence — a verified fact. Redacted.
  readonly failureFrames: readonly FailureFrame[];
}

// Model output, all redacted, explicitly UNVERIFIED.
export interface Hypothesis {
  readonly rootCause?: string | undefined;
  readonly regressionTestStrategy?: string | undefined;
  readonly uncertainty?: string | undefined;
  readonly confidence?: "low" | "medium" | "high" | undefined;
}

export interface ChangedFile {
  // Workspace-relative path of a file the patch changes (redacted).
  readonly path: string;
  readonly kind: PatchChangeKind;
  readonly addedLines: number;
  readonly removedLines: number;
  // True when the path is a manifest/config edit (package.json, tsconfig*.json) — elevated review.
  readonly elevatedReview: boolean;
}

export interface BugInvestigationReport {
  readonly workflowId: "bug-investigation";
  readonly status: BugWorkflowStatus;
  readonly modelId: string;
  // Wall-clock duration in milliseconds for the entire workflow.
  readonly durationMs: number;

  // Facts the workflow established.
  readonly verified: VerifiedFindings;
  // Model output, redacted, UNVERIFIED.
  readonly hypothesis: Hypothesis;

  // The model's proposed unified diff (redacted) — the reviewable fix. Absent on
  // investigation-only / rejected / cancelled-before-patch.
  readonly proposedDiff?: string | undefined;
  // #6 renderDryRun validation summary (redacted). Present when a valid patch was produced.
  readonly dryRunPreview?: string | undefined;
  // Files the patch changes. Empty when no patch was produced.
  readonly changedFiles: readonly ChangedFile[];
  // Best-effort count of regression-test cases added by the diff. Not authoritative.
  readonly regressionCoverage: number;
  // Why verification did not run. Present when verification was skipped.
  readonly verificationSkipReason?: string | undefined;
  // UI-renderable next actions, each a plain redacted string.
  readonly nextActions: readonly string[];
  // Redacted failure detail for terminal failed reports. Omitted on normal workflow outcomes.
  readonly failureReason?: string | undefined;

  // Number of model calls made (including retries).
  readonly modelCallCount: number;
  // Number of patch rejections before a valid patch was accepted (or the loop gave up).
  readonly patchRetryCount: number;
}

// ─── Model-output contract (D9) ──────────────────────────────────────────────────────

export interface ParsedBugOutput {
  // The proposed unified diff (raw, unredacted). Empty string when no diff content was found.
  readonly diff: string;
  readonly rootCause: string | undefined;
  readonly regressionTestStrategy: string | undefined;
  readonly uncertainty: string | undefined;
  readonly confidence: "low" | "medium" | "high" | undefined;
}
