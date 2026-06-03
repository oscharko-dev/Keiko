// All interfaces, type aliases, and frozen constant tables for the unit-test generation
// workflow (ADR-0008 D2/D3/D7). No runtime logic lives here beyond the frozen tables the type
// layer exposes as values, mirroring the ADR-0003/0004/0005/0006/0007 `types.ts` precedent.
// `readonly` everywhere; optional props are `| undefined` because exactOptionalPropertyTypes
// is on. Every report shape is plain JSON-serializable so the #10 audit ledger can persist it.

import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { SpawnFn, WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import type { TestFramework, WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { VerificationAuditSummary } from "../../../../src/verification/index.js";
import type { WorkflowEventSink } from "./events.js";

// ─── Status & target selection ───────────────────────────────────────────────────

// WorkflowStatus, FileNamingStyle, WorkflowLimits, and DEFAULT_WORKFLOW_LIMITS were extracted to
// @oscharko-dev/keiko-contracts in issue #158. Re-exported here so consumers of
// "./types.js" continue to resolve them unchanged.
import type {
  FileNamingStyle,
  WorkflowLimits,
  WorkflowStatus,
} from "@oscharko-dev/keiko-contracts";

export type {
  WorkflowStatus,
  FileNamingStyle,
  WorkflowLimits,
} from "@oscharko-dev/keiko-contracts";
export { DEFAULT_WORKFLOW_LIMITS } from "@oscharko-dev/keiko-contracts";

// Target selection: exactly one of file/module/changedFiles.
export type UnitTestTarget =
  | {
      readonly kind: "file";
      readonly filePath: string;
      readonly targetFunction?: string | undefined;
    }
  | { readonly kind: "module"; readonly moduleDir: string }
  | { readonly kind: "changedFiles"; readonly filePaths: readonly string[] };

// ─── Conventions (D7) ──────────────────────────────────────────────────────────────

export interface TestConventions {
  readonly framework: TestFramework;
  readonly testDirs: readonly string[];
  readonly fileNamingStyle: FileNamingStyle;
  // Up to 2 excerpts of nearby test files sampled from the ContextPack (already redacted by #5).
  readonly assertionStyleSamples: readonly string[];
}

// ─── Input & deps (D2) ─────────────────────────────────────────────────────────────

export interface UnitTestWorkflowInput {
  // The workspace root (absolute path).
  readonly workspaceRoot: string;
  readonly target: UnitTestTarget;
  // When true, the validated patch is written to disk and verification runs. When false
  // (default), only the diff preview and report are produced. FAIL-CLOSED: applyPatch in #6
  // throws PatchApplyDisabledError unless this is true.
  readonly apply?: boolean | undefined;
  // Model ID to use (must be registered in the gateway config).
  readonly modelId: string;
  // Per-workflow resource limits. Defaults to DEFAULT_WORKFLOW_LIMITS.
  readonly limits?: Partial<WorkflowLimits> | undefined;
}

export interface UnitTestWorkflowDeps {
  // The model port to use for the generation call. Injected; mocked in tests.
  readonly model: ModelPort;
  // Workspace filesystem. Defaults to nodeWorkspaceFs.
  readonly fs?: WorkspaceFs | undefined;
  // Filesystem WRITE port used by applyPatch in apply mode. Defaults to nodeWorkspaceWriter.
  // Injected as a recording writer in unit tests to assert write behaviour without touching disk.
  readonly writer?: WorkspaceWriter | undefined;
  // Spawn function for runCommand / runVerification. Defaults to nodeSpawnFn.
  readonly spawn?: SpawnFn | undefined;
  // Monotonic clock. Defaults to Date.now.
  readonly now?: (() => number) | undefined;
  // Unique ID source for event runId. Defaults to crypto.randomUUID.
  readonly idSource?: (() => string) | undefined;
  // Event sink for workflow progress events. No-op by default.
  readonly sink?: WorkflowEventSink | undefined;
  // Process environment for runCommand env isolation. Defaults to process.env.
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  // AbortSignal for cancellation.
  readonly signal?: AbortSignal | undefined;
}

// ─── Report (D3 + steering note A: proposedDiff) ─────────────────────────────────────

export interface AddedTestFile {
  // Workspace-relative path of the test file created or modified by the patch.
  readonly path: string;
  // Number of test cases added (lines beginning with test(/it(/describe(). Best-effort; not authoritative.
  readonly estimatedTestCount: number;
}

export interface UnitTestWorkflowReport {
  readonly workflowId: "unit-test-generation";
  readonly status: WorkflowStatus;
  readonly modelId: string;
  // Wall-clock duration in milliseconds for the entire workflow.
  readonly durationMs: number;

  // Dry-run preview from #6 renderDryRun (a redacted VALIDATION SUMMARY, not the diff).
  // Present in dry-run and apply mode. Absent when no valid patch was produced.
  readonly dryRunPreview?: string | undefined;

  // The model's proposed unified diff (redacted) — the reviewable test code (steering note A).
  // Present whenever a parseable, in-scope patch was produced; absent on rejection/cancellation.
  readonly proposedDiff?: string | undefined;

  // Patch files that were added or modified. Empty on rejection or dry-run with no valid patch.
  readonly addedTestFiles: readonly AddedTestFile[];

  // Model-generated prose summary of what behaviors are covered (redacted). Absent if absent in output.
  readonly coveredBehavior?: string | undefined;

  // Model-generated prose summary of known gaps (redacted). Absent if absent in output.
  readonly knownGaps?: string | undefined;

  // UI-renderable next actions, each a plain redacted string.
  readonly nextActions: readonly string[];
  // Redacted failure detail for terminal failed reports. Omitted on normal workflow outcomes.
  readonly failureReason?: string | undefined;

  // Verification run summary. Present only in apply mode when verification ran.
  readonly verificationSummary?: VerificationAuditSummary | undefined;

  // Human-readable explanation of why verification was skipped. Present when no verification ran.
  readonly verificationSkipReason?: string | undefined;

  // Number of model calls made (including retries).
  readonly modelCallCount: number;

  // Number of patch rejections before a valid patch was accepted.
  readonly patchRetryCount: number;
}
