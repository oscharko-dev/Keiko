// Report assembly and Markdown rendering (ADR-0009 D3). assembleBugReport composes the
// JSON-serializable BugInvestigationReport from pipeline stage outputs, enforcing the STRUCTURAL
// verified/hypothesis split: `verified` carries only facts the workflow established (patch validated,
// patch applied, verification summary, parsed failure frames) and `hypothesis` carries the redacted,
// explicitly-UNVERIFIED model output. ALL prose, the diff, the dry-run preview, frame paths, changed
// paths, and nextActions are redacted via redact() here — defence in depth on top of upstream
// redaction. renderBugMarkdownReport produces the CLI text path. Pure: no IO, no clock; the caller
// injects durationMs and counters.

import { redact } from "@oscharko-dev/keiko-security";
import type { PatchFileChange } from "@oscharko-dev/keiko-tools";
import type { VerificationAuditSummary } from "@oscharko-dev/keiko-verification";
import { isElevatedReviewPath } from "./guard.js";
import type {
  BugInvestigationReport,
  BugWorkflowStatus,
  ChangedFile,
  FailureFrame,
  Hypothesis,
} from "./types.js";

const TEST_CASE_PREFIXES: readonly string[] = ["test(", "it(", "describe("];

// Best-effort count of added regression-test cases: added (`+`) lines whose trimmed text begins
// with a known test-case opener. Not authoritative — informational only.
function estimateRegressionCount(files: readonly PatchFileChange[]): number {
  let count = 0;
  for (const file of files) {
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
  }
  return count;
}

function toChangedFiles(files: readonly PatchFileChange[]): readonly ChangedFile[] {
  return files.map((file) => ({
    path: redact(file.path),
    kind: file.kind,
    addedLines: file.addedLines,
    removedLines: file.removedLines,
    elevatedReview: isElevatedReviewPath(file.path),
  }));
}

function redactFrames(frames: readonly FailureFrame[]): readonly FailureFrame[] {
  return frames.map((frame) =>
    frame.line === undefined
      ? { file: redact(frame.file), line: undefined }
      : { file: redact(frame.file), line: frame.line },
  );
}

function redactHypothesis(hypothesis: Hypothesis): Hypothesis {
  return {
    rootCause: redactOptional(hypothesis.rootCause),
    regressionTestStrategy: redactOptional(hypothesis.regressionTestStrategy),
    uncertainty: redactOptional(hypothesis.uncertainty),
    confidence: hypothesis.confidence,
  };
}

function redactOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redact(value);
}

export interface BugReportParts {
  readonly status: BugWorkflowStatus;
  readonly modelId: string;
  readonly durationMs: number;
  readonly patchFiles: readonly PatchFileChange[];
  readonly patchValidates: boolean;
  readonly patchApplied: boolean;
  readonly verification: VerificationAuditSummary | undefined;
  readonly failureFrames: readonly FailureFrame[];
  readonly hypothesis: Hypothesis;
  readonly proposedDiff: string | undefined;
  readonly dryRunPreview: string | undefined;
  readonly verificationSkipReason: string | undefined;
  readonly nextActions: readonly string[];
  readonly failureReason?: string | undefined;
  readonly modelCallCount: number;
  readonly patchRetryCount: number;
}

export function assembleBugReport(parts: BugReportParts): BugInvestigationReport {
  return {
    workflowId: "bug-investigation",
    status: parts.status,
    modelId: parts.modelId,
    durationMs: parts.durationMs,
    verified: {
      patchValidates: parts.patchValidates,
      patchApplied: parts.patchApplied,
      verification: parts.verification,
      failureFrames: redactFrames(parts.failureFrames),
    },
    hypothesis: redactHypothesis(parts.hypothesis),
    proposedDiff: redactOptional(parts.proposedDiff),
    dryRunPreview: redactOptional(parts.dryRunPreview),
    changedFiles: toChangedFiles(parts.patchFiles),
    regressionCoverage: estimateRegressionCount(parts.patchFiles),
    verificationSkipReason: redactOptional(parts.verificationSkipReason),
    nextActions: parts.nextActions.map((action) => redact(action)),
    failureReason: redactOptional(parts.failureReason),
    modelCallCount: parts.modelCallCount,
    patchRetryCount: parts.patchRetryCount,
  };
}

// ─── Markdown rendering ──────────────────────────────────────────────────────────

function sectionIf(heading: string, body: string | undefined): readonly string[] {
  return body === undefined ? [] : [`## ${heading}`, body, ""];
}

function frameLines(report: BugInvestigationReport): readonly string[] {
  if (report.verified.failureFrames.length === 0) {
    return [];
  }
  const rows = report.verified.failureFrames.map((f) =>
    f.line === undefined ? `- ${f.file}` : `- ${f.file}:${String(f.line)}`,
  );
  return ["## Failure locations (verified)", ...rows, ""];
}

function changedFileLines(report: BugInvestigationReport): readonly string[] {
  if (report.changedFiles.length === 0) {
    return [];
  }
  const rows = report.changedFiles.map((f) => {
    const flag = f.elevatedReview ? " [elevated review]" : "";
    return `- ${f.kind} ${f.path} (+${String(f.addedLines)} -${String(f.removedLines)})${flag}`;
  });
  return ["## Changed files (verified)", ...rows, ""];
}

function verificationLines(report: BugInvestigationReport): readonly string[] {
  if (report.verified.verification !== undefined) {
    return [
      "## Verification (verified)",
      `Status: ${report.verified.verification.overallStatus}`,
      "",
    ];
  }
  if (report.verificationSkipReason !== undefined) {
    return ["## Verification (verified)", report.verificationSkipReason, ""];
  }
  return [];
}

function hypothesisLines(report: BugInvestigationReport): readonly string[] {
  const h = report.hypothesis;
  // Suppress the section entirely when the model produced no hypothesis (rejected/failed paths), so
  // the rendered report does not show a bare "UNVERIFIED" header with no content.
  const hasContent =
    h.rootCause !== undefined ||
    h.regressionTestStrategy !== undefined ||
    h.uncertainty !== undefined ||
    h.confidence !== undefined;
  if (!hasContent) {
    return [];
  }
  return [
    "## Hypothesis (UNVERIFIED — model output)",
    ...sectionIf("Root cause", h.rootCause),
    ...sectionIf("Regression test", h.regressionTestStrategy),
    ...sectionIf("Uncertainty", h.uncertainty),
    ...(h.confidence === undefined ? [] : [`Confidence: ${h.confidence}`, ""]),
  ];
}

// A human-readable Markdown report for the CLI text path. Every field is already redacted by
// assembleBugReport, so rendering is plain string composition. Verified facts and the UNVERIFIED
// model hypothesis are clearly separated (AC #7).
export function renderBugMarkdownReport(report: BugInvestigationReport): string {
  return [
    `# Bug investigation: ${report.status}`,
    `Model: ${report.modelId} · ${String(report.durationMs)}ms · ` +
      `${String(report.modelCallCount)} model call(s) · ${String(report.patchRetryCount)} retry(ies)`,
    "",
    ...frameLines(report),
    ...changedFileLines(report),
    ...verificationLines(report),
    ...hypothesisLines(report),
    ...sectionIf("Failure", report.failureReason),
    ...(report.nextActions.length > 0
      ? ["## Next actions", ...report.nextActions.map((a) => `- ${a}`), ""]
      : []),
  ].join("\n");
}
