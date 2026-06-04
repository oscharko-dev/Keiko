// All verification-layer interfaces and the frozen default limits. No runtime logic lives here
// beyond the frozen constant tables the type layer exposes as values, mirroring the
// ADR-0003/0004/0005/0006 `types.ts` precedent. `readonly` everywhere; optional props are
// `| undefined` because exactOptionalPropertyTypes is on. Every shape is plain JSON-serializable
// so the #10 audit ledger can persist a VerificationReport without ad-hoc parsing.

import type { NetworkPolicy } from "./tools.js";

// ─── Verification kinds & status ─────────────────────────────────────────────────

export type VerificationKind = "test" | "targeted-test" | "typecheck" | "lint" | "build";

// The outcome taxonomy classifyOutcome maps every run path to (ADR-0007 D1). `denied`,
// `timed-out`, `cancelled`, and `resource-exceeded` distinguish the failure cause so the audit
// ledger and CLI can report WHY a step did not pass, not merely that it failed.
export type VerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "denied"
  | "timed-out"
  | "cancelled"
  | "resource-exceeded";

// ─── Resource limits (the four documented dimensions) ────────────────────────────

export type ResourceDimension = "wall-time" | "output-size" | "memory" | "network";

// One row per dimension in VerificationResult.appliedLimits. `enforced` is HONEST: it is false
// for dimensions Wave 1 documents but does not OS-enforce (network always; memory off Linux or
// without a ceiling). `breached` is set only on the dimension that actually fired for this step.
export interface ResourceLimitDecision {
  readonly dimension: ResourceDimension;
  // The numeric ceiling for time/output/memory; for network the policy string ("none"/"inherit").
  readonly limit: number | string;
  readonly enforced: boolean;
  readonly note?: string | undefined;
  readonly breached?: boolean | undefined;
}

export interface VerificationResourceLimits {
  readonly wallTimeMs: number;
  readonly maxOutputBytes: number;
  // undefined => no memory ceiling requested; the monitor returns a documented no-op.
  readonly maxMemoryBytes: number | undefined;
  readonly network: NetworkPolicy;
}

// Wave-1 defaults. maxMemoryBytes is undefined by default: memory enforcement is opt-in and
// Linux-only (ADR-0007 D2/D3). network defaults to the no-network posture, documented-not-enforced.
export const DEFAULT_VERIFICATION_LIMITS: VerificationResourceLimits = {
  wallTimeMs: 120_000,
  maxOutputBytes: 1_048_576,
  maxMemoryBytes: undefined,
  network: "none",
} as const;

// ─── Plan ─────────────────────────────────────────────────────────────────────────

export interface VerificationStep {
  readonly kind: VerificationKind;
  // The npm script name backing this step, or undefined for a synthesised invocation
  // (targeted tests) or a skipped step.
  readonly scriptName: string | undefined;
  readonly command: string;
  readonly args: readonly string[];
  readonly limits: VerificationResourceLimits;
  // Present iff the step is pre-marked skip (no detected script for the kind, ADR-0007 D4).
  readonly skipReason?: string | undefined;
}

export interface VerificationPlan {
  readonly workspaceRoot: string;
  readonly steps: readonly VerificationStep[];
}

// ─── Result & report ───────────────────────────────────────────────────────────────

export interface VerificationResult {
  readonly kind: VerificationKind;
  readonly scriptName: string | undefined;
  readonly command: string;
  readonly args: readonly string[];
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  // Always true for a result carrying outputSummary: the digest is run through redact().
  readonly redacted: boolean;
  // Redacted, byte-capped digest of stdout+stderr. Empty for skipped/denied steps (no output).
  readonly outputSummary: string;
  readonly appliedLimits: readonly ResourceLimitDecision[];
  // A short, redacted human explanation (e.g. "no script", "denied: ...", "memory ceiling").
  readonly detail?: string | undefined;
}

export interface VerificationReport {
  readonly workspaceRoot: string;
  readonly results: readonly VerificationResult[];
  readonly overallStatus: VerificationStatus;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly counts: Readonly<Record<VerificationStatus, number>>;
}

// ─── Detection ──────────────────────────────────────────────────────────────────────

// The npm scripts detected in package.json, plus the kind→scriptName mapping the plan consumes.
export interface ScriptCatalog {
  readonly scripts: Readonly<Record<string, string>>;
  readonly mapping: ScriptMapping;
}

export interface ScriptMapping {
  readonly test: string | undefined;
  readonly typecheck: string | undefined;
  readonly lint: string | undefined;
  readonly build: string | undefined;
}
