// Final-report payload + renderer (ADR-0010 D9). buildEvidenceReport produces a structured,
// JSON-serializable summary of a persisted manifest; renderEvidenceReport renders it for the CLI.
// Both are PURE (no IO). knownLimitations is static text stating the Wave-1 evidence bounds
// (no tamper-evidence, no encryption at rest, per-run cost attribution) so a reviewer reads the
// honest trust boundary alongside the evidence.

import type { CostClass } from "../gateway/types.js";
import type { RunOutcome } from "../harness/types.js";
import type { VerificationStatus } from "../verification/types.js";
import type {
  EvidenceManifest,
  EvidenceTaskType,
  EvidenceUsageTotals,
  EvidenceVerificationResult,
} from "./types.js";

export interface EvidenceReport {
  readonly evidenceLocation: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly taskType: EvidenceTaskType;
  readonly outcome: RunOutcome;
  readonly changedFiles: number;
  readonly usageTotals: EvidenceUsageTotals;
  readonly costClass: CostClass | "unknown";
  readonly verificationStatus: VerificationStatus | "not-run";
  readonly knownLimitations: readonly string[];
}

const KNOWN_LIMITATIONS: readonly string[] = [
  "Evidence files are developer-writable: no tamper-evidence or immutability (out of scope).",
  "Evidence is stored as plaintext JSON: no encryption at rest; redaction removes known shapes only.",
  "Cost attribution is per-run (the declared model's class), not per model call.",
];

function statusFromHarnessResults(
  results: readonly EvidenceVerificationResult[] | undefined,
): VerificationStatus | "not-run" {
  if (results === undefined || results.length === 0) {
    return "not-run";
  }
  return results.every((result) => result.passed) ? "passed" : "failed";
}

function verificationStatus(manifest: EvidenceManifest): VerificationStatus | "not-run" {
  return (
    manifest.verification?.overallStatus ?? statusFromHarnessResults(manifest.verificationResults)
  );
}

export function buildEvidenceReport(manifest: EvidenceManifest, location: string): EvidenceReport {
  return {
    evidenceLocation: location,
    runId: manifest.run.runId,
    fingerprint: manifest.run.fingerprint,
    taskType: manifest.run.taskType,
    outcome: manifest.run.outcome,
    changedFiles: manifest.patch?.changedFiles ?? 0,
    usageTotals: manifest.usageTotals,
    costClass: manifest.model.costClass,
    verificationStatus: verificationStatus(manifest),
    knownLimitations: KNOWN_LIMITATIONS,
  };
}

export function renderEvidenceReport(report: EvidenceReport): string {
  const { usageTotals: u } = report;
  const lines = [
    `Evidence: ${report.evidenceLocation}`,
    `  run            ${report.runId} (fingerprint ${report.fingerprint})`,
    `  task           ${report.taskType}`,
    `  outcome        ${report.outcome}`,
    `  changed files  ${String(report.changedFiles)}`,
    `  usage          ${String(u.promptTokens)} prompt / ${String(u.completionTokens)} completion tokens, ` +
      `${String(u.requestCount)} request(s), ${String(u.totalLatencyMs)}ms`,
    `  cost class     ${report.costClass}`,
    `  verification   ${report.verificationStatus}`,
    "  known limitations:",
    ...report.knownLimitations.map((limitation) => `    - ${limitation}`),
  ];
  return `${lines.join("\n")}\n`;
}
