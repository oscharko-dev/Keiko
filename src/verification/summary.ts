// The render surfaces over a VerificationReport (ADR-0007). buildVerificationSummary is the
// structured CLI/SDK view (keeps the redacted output digest); summarizeForAudit is the audit-ledger
// projection that EXCLUDES raw output text (mirroring ADR-0005 audit excerpt-exclusion), keeping
// only status/exit/duration/appliedLimits/counts; renderMarkdownSummary is a PR/issue table. Every
// composed string is run through redact() so nothing a summary emits can leak a secret. Pure — no IO.

import { redact } from "../gateway/redaction.js";
import type {
  ResourceLimitDecision,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from "./types.js";

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

export function buildVerificationSummary(report: VerificationReport): VerificationSummary {
  return {
    workspaceRoot: report.workspaceRoot,
    overallStatus: report.overallStatus,
    durationMs: report.durationMs,
    counts: report.counts,
    results: report.results.map((r) => ({
      kind: r.kind,
      scriptName: r.scriptName,
      command: redact(`${r.command} ${r.args.join(" ")}`.trim()),
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      truncated: r.truncated,
      // r.outputSummary is already redacted at the orchestrator; re-redact as defence in depth.
      outputSummary: redact(r.outputSummary),
      appliedLimits: r.appliedLimits,
      detail: r.detail === undefined ? undefined : redact(r.detail),
    })),
  };
}

export function summarizeForAudit(report: VerificationReport): VerificationAuditSummary {
  return {
    workspaceRoot: report.workspaceRoot,
    overallStatus: report.overallStatus,
    durationMs: report.durationMs,
    counts: report.counts,
    results: report.results.map((r) => ({
      kind: r.kind,
      scriptName: r.scriptName,
      command: redact(`${r.command} ${r.args.join(" ")}`.trim()),
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      truncated: r.truncated,
      appliedLimits: r.appliedLimits,
    })),
  };
}

function statusMark(status: VerificationStatus): string {
  if (status === "passed") {
    return "pass";
  }
  if (status === "skipped") {
    return "skip";
  }
  return "FAIL";
}

function markdownRow(result: VerificationResult): string {
  const cmd = redact(`${result.command} ${result.args.join(" ")}`.trim());
  const detail = result.detail === undefined ? "" : redact(result.detail);
  const exit = result.exitCode === null ? "—" : String(result.exitCode);
  return `| ${result.kind} | ${result.status} | ${exit} | ${String(result.durationMs)} | \`${cmd}\` | ${detail} |`;
}

// A PR/issue Markdown table. Every cell that can carry command-derived text is redacted.
export function renderMarkdownSummary(report: VerificationReport): string {
  const header = `### Verification: ${statusMark(report.overallStatus)} (${report.overallStatus})`;
  const tableHead =
    "| Kind | Status | Exit | ms | Command | Detail |\n| --- | --- | --- | --- | --- | --- |";
  const rows = report.results.map(markdownRow).join("\n");
  return `${header}\n\n${tableHead}\n${rows}\n`;
}
