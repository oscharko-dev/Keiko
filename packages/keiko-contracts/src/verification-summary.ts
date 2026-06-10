// Pure type interfaces for the verification summary layer (ADR-0007). The runtime functions
// (buildVerificationSummary, summarizeForAudit, renderMarkdownSummary) stay in
// packages/keiko-verification/src/summary.ts. These types were extracted to contracts (issue #158) so the
// audit ledger (#10) and evidence layer can reference them without a circular dependency.

import type {
  ResourceLimitDecision,
  VerificationResult,
  VerificationStatus,
} from "./verification.js";

export interface VerificationResultSummary {
  readonly kind: VerificationResult["kind"];
  readonly scriptName: string | undefined;
  readonly command: string;
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly outputSummary: string;
  readonly appliedLimits: readonly ResourceLimitDecision[];
  readonly detail: string | undefined;
}

export interface VerificationSummary {
  readonly workspaceRoot: string;
  readonly overallStatus: VerificationStatus;
  readonly durationMs: number;
  readonly counts: Readonly<Record<VerificationStatus, number>>;
  readonly results: readonly VerificationResultSummary[];
}

// The audit projection: identical metadata MINUS the raw output digest and detail text, so no
// command output ever reaches the audit ledger (#10). appliedLimits and counts are retained.
export interface AuditResultEntry {
  readonly kind: VerificationResult["kind"];
  readonly scriptName: string | undefined;
  readonly command: string;
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly appliedLimits: readonly ResourceLimitDecision[];
}

export interface VerificationAuditSummary {
  readonly workspaceRoot: string;
  readonly overallStatus: VerificationStatus;
  readonly durationMs: number;
  readonly counts: Readonly<Record<VerificationStatus, number>>;
  readonly results: readonly AuditResultEntry[];
}
