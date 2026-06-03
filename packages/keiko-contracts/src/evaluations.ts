// All evaluation interfaces and type aliases for the Wave 1 evaluation harness (ADR-0012 D6/D8/D11).
// No runtime logic lives here beyond the frozen schema-version constant the type layer exposes as a
// value. `readonly` everywhere; optional props are `| undefined` because exactOptionalPropertyTypes
// is on. Every scorecard shape is plain JSON-serializable so the harness can emit it to stdout/file.

import type { NormalizedResponse } from "./gateway.js";

// ─── Dimension identity (D6) ────────────────────────────────────────────────────────

export type EvaluationDimension =
  | "task-completion"
  | "patch-correctness"
  | "test-pass-rate"
  | "verification-completeness"
  | "patch-size"
  | "audit-completeness"
  | "unsafe-action-rejection";

// The seven scored dimensions in their canonical scorecard order. A scorecard always carries one
// ScorecardEntry per name here, even when no fixture exercises the dimension (all not-applicable).
export const EVALUATION_DIMENSIONS: readonly EvaluationDimension[] = [
  "task-completion",
  "patch-correctness",
  "test-pass-rate",
  "verification-completeness",
  "patch-size",
  "audit-completeness",
  "unsafe-action-rejection",
] as const;

// ─── Oracle (D6) ───────────────────────────────────────────────────────────────────

export interface FixtureOracle {
  // The terminal statuses that are acceptable for this fixture.
  readonly expectedStatuses: readonly string[];
  // When true, the report must carry a non-empty proposedDiff.
  readonly expectPatch: boolean;
  // When true, verification being skipped is acceptable (e.g. dry-run or framework-unknown fixture).
  readonly expectVerificationSkip: boolean;
  // Maximum number of changed files the patch may produce. Used for the patch-size dimension.
  readonly maxExpectedChangedFiles: number;
  // Maximum patch byte size. Used for the patch-size dimension.
  readonly maxExpectedPatchBytes: number;
}

// ─── Fixture (D3) ─────────────────────────────────────────────────────────────────

export type WorkflowKind = "unit-tests" | "bug-investigation";

export interface EvaluationFixture {
  // Stable, kebab-case name. Used as the fixture identifier in scorecard output.
  readonly name: string;
  readonly workflowKind: WorkflowKind;
  // Workspace files materialized to a temp dir before the workflow runs. Keys are workspace-relative
  // POSIX paths; values are file contents as strings. Intentionally buggy code is expressed as valid
  // TypeScript with logic errors (wrong operator, off-by-one) — never type errors — so tsc never fails.
  readonly workspaceFiles: Record<string, string>;
  // For unit-test fixtures: the UnitTestWorkflowInput fields minus workspaceRoot and modelId, which
  // the runner supplies. For bug-investigation fixtures: the BugInvestigationInput fields minus
  // workspaceRoot and modelId. The runner narrows this into a typed input (never a blind cast).
  readonly workflowInput: Record<string, unknown>;
  // Whether the runner should drive the workflow in apply mode (writes via a recording writer + fake
  // spawn) so the test-pass-rate and verification-completeness dimensions score real pass/fail.
  readonly apply?: boolean | undefined;
  // The scripted model transcript for offline mode. Each entry is a NormalizedResponse or an Error.
  // The runner builds a ScriptedModelPort from this array and injects it as deps.model.
  readonly mockTranscript: readonly (NormalizedResponse | Error)[];
  // Which dimensions this fixture is designed to test.
  readonly dimensions: ReadonlySet<EvaluationDimension>;
  readonly oracle: FixtureOracle;
}

// ─── Result types (D6/D8) ───────────────────────────────────────────────────────────

export type DimensionOutcome = "pass" | "fail" | "not-applicable";

export interface DimensionResult {
  readonly dimension: EvaluationDimension;
  readonly outcome: DimensionOutcome;
  // Present when outcome is "fail". Human-readable explanation (no model content).
  readonly reason?: string | undefined;
}

export interface FixtureRunResult {
  readonly fixtureName: string;
  readonly workflowKind: WorkflowKind;
  // Elapsed milliseconds for this fixture run (from the injected clock; deterministic in offline mode).
  readonly durationMs: number;
  readonly dimensionResults: readonly DimensionResult[];
  // The raw workflow report (UnitTestWorkflowReport or BugInvestigationReport), JSON-serializable.
  readonly report: Record<string, unknown>;
}

export interface ScorecardEntry {
  readonly dimension: EvaluationDimension;
  readonly passCount: number;
  readonly failCount: number;
  readonly notApplicableCount: number;
  // pass / (pass + fail); null when passCount + failCount === 0.
  readonly passRate: number | null;
}

export interface SurfaceParityCheckResult {
  readonly check: string;
  readonly workflowKind: WorkflowKind;
  readonly passed: boolean;
  readonly reason?: string | undefined;
}

export interface SurfaceParityResult {
  readonly allPassed: boolean;
  readonly checks: readonly SurfaceParityCheckResult[];
}

export interface LiveRunContext {
  readonly modelId: string;
  // Gateway config descriptor. NO secrets — model IDs and counts only, never apiKey/baseUrl values.
  readonly configDescriptor: string;
  // Paths to EvidenceManifest files written during this evaluation run.
  readonly evidenceRefs: readonly string[];
}

export const EVAL_SCORECARD_SCHEMA_VERSION = "1" as const;

export interface ScorecardSummary {
  // Total fixtures attempted.
  readonly totalFixtures: number;
  // Fixtures where all applicable dimensions passed.
  readonly fullyPassedFixtures: number;
  // true when all unsafe-action-rejection fixtures passed AND surfaceParity passed.
  readonly safetyGatePassed: boolean;
  // true when safetyGatePassed && all applicable dimension passRates meet Go/No-Go thresholds (D13).
  readonly pilotReadyIndicator: boolean;
}

export interface EvalScorecard {
  readonly schemaVersion: typeof EVAL_SCORECARD_SCHEMA_VERSION;
  // ISO 8601 timestamp of the evaluation run start.
  readonly evaluatedAt: string;
  readonly mode: EvaluationMode;
  // Present in live mode only. Absent in offline mode.
  readonly liveRunContext?: LiveRunContext | undefined;
  readonly dimensions: readonly ScorecardEntry[];
  readonly surfaceParity: SurfaceParityResult;
  readonly fixtureResults: readonly FixtureRunResult[];
  readonly summary: ScorecardSummary;
}

export type EvaluationMode = "offline" | "live";
