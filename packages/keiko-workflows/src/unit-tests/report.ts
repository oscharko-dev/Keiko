// Report assembly and Markdown rendering (ADR-0008 D3, steering note A). assembleReport composes
// the JSON-serializable UnitTestWorkflowReport from pipeline stage outputs; renderMarkdownReport
// produces the CLI text path. ALL prose (coveredBehavior, knownGaps, nextActions), the dry-run
// preview, the proposed diff, verificationSkipReason, and addedTestFiles[].path are redacted via
// redact() here so nothing the report carries can leak a secret — defence in depth on top of the
// redaction already applied upstream. Pure: no IO, no clock; the caller injects durationMs and counters.

import { redact } from "@oscharko-dev/keiko-security";
import type { PatchFileChange } from "@oscharko-dev/keiko-tools";
import type { VerificationAuditSummary } from "@oscharko-dev/keiko-verification";
import type { AddedTestFile, UnitTestWorkflowReport, WorkflowStatus } from "./types.js";

const TEST_CASE_PREFIXES: readonly string[] = ["test(", "it(", "describe("];

// Best-effort count of added test cases: added (`+`) lines whose trimmed text begins with a known
// test-case opener. Not authoritative — purely informational for the report.
function estimateTestCount(file: PatchFileChange): number {
  let count = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (!line.startsWith("+")) {
        continue;
      }
      const trimmed = line.slice(1).trimStart();
      if (TEST_CASE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
        count += 1;
      }
    }
  }
  return count;
}

function toAddedTestFiles(files: readonly PatchFileChange[]): readonly AddedTestFile[] {
  return files.map((file) => ({
    path: redact(file.path),
    estimatedTestCount: estimateTestCount(file),
  }));
}

export interface ReportParts {
  readonly status: WorkflowStatus;
  readonly modelId: string;
  readonly durationMs: number;
  readonly patchFiles: readonly PatchFileChange[];
  readonly dryRunPreview: string | undefined;
  readonly proposedDiff: string | undefined;
  readonly coveredBehavior: string | undefined;
  readonly knownGaps: string | undefined;
  readonly nextActions: readonly string[];
  readonly failureReason?: string | undefined;
  readonly verificationSummary: VerificationAuditSummary | undefined;
  readonly verificationSkipReason: string | undefined;
  readonly modelCallCount: number;
  readonly patchRetryCount: number;
}

function redactOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redact(value);
}

export function assembleReport(parts: ReportParts): UnitTestWorkflowReport {
  return {
    workflowId: "unit-test-generation",
    status: parts.status,
    modelId: parts.modelId,
    durationMs: parts.durationMs,
    dryRunPreview: redactOptional(parts.dryRunPreview),
    proposedDiff: redactOptional(parts.proposedDiff),
    addedTestFiles: toAddedTestFiles(parts.patchFiles),
    coveredBehavior: redactOptional(parts.coveredBehavior),
    knownGaps: redactOptional(parts.knownGaps),
    nextActions: parts.nextActions.map((action) => redact(action)),
    failureReason: redactOptional(parts.failureReason),
    verificationSummary: parts.verificationSummary,
    verificationSkipReason: redactOptional(parts.verificationSkipReason),
    modelCallCount: parts.modelCallCount,
    patchRetryCount: parts.patchRetryCount,
  };
}

function sectionIf(heading: string, body: string | undefined): readonly string[] {
  return body === undefined ? [] : [`## ${heading}`, body, ""];
}

function fileLines(report: UnitTestWorkflowReport): readonly string[] {
  if (report.addedTestFiles.length === 0) {
    return [];
  }
  const rows = report.addedTestFiles.map(
    (f) => `- ${f.path} (~${String(f.estimatedTestCount)} test case(s))`,
  );
  return ["## Test files", ...rows, ""];
}

function verificationLine(report: UnitTestWorkflowReport): readonly string[] {
  if (report.verificationSummary !== undefined) {
    return [`## Verification`, `Status: ${report.verificationSummary.overallStatus}`, ""];
  }
  if (report.verificationSkipReason !== undefined) {
    return [`## Verification`, report.verificationSkipReason, ""];
  }
  return [];
}

// A human-readable Markdown report for the CLI text path. Every field is already redacted by
// assembleReport, so rendering is plain string composition.
export function renderMarkdownReport(report: UnitTestWorkflowReport): string {
  return [
    `# Unit-test generation: ${report.status}`,
    `Model: ${report.modelId} · ${String(report.durationMs)}ms · ` +
      `${String(report.modelCallCount)} model call(s) · ${String(report.patchRetryCount)} retry(ies)`,
    "",
    ...fileLines(report),
    ...sectionIf("Covered behavior", report.coveredBehavior),
    ...sectionIf("Known gaps", report.knownGaps),
    ...sectionIf("Failure", report.failureReason),
    ...verificationLine(report),
    ...(report.nextActions.length > 0
      ? ["## Next actions", ...report.nextActions.map((a) => `- ${a}`), ""]
      : []),
  ].join("\n");
}
