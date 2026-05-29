// Prompt construction (ADR-0009 D9). Builds the system + user ChatMessage array for the single
// investigation call. PURE: no IO, no clock, no randomness — the same inputs always yield the same
// messages. The system message specifies the model-output contract (an OPTIONAL fenced ```diff
// block plus labeled prose sections) that parse.ts consumes, and explicitly tells the model to OMIT
// the diff when evidence is insufficient (the investigation-only outcome, D10). Context excerpts and
// failure messages handed in are already redacted by #5 / the workflow; this module does no redaction.

import type { ChatMessage } from "../../gateway/types.js";
import type { ContextPack } from "../../workspace/index.js";
import type { BugReportInput, FailureEvidence } from "./types.js";

const OUTPUT_CONTRACT =
  "Respond with an OPTIONAL minimal fix as a unified diff inside a single fenced code block opened " +
  "with ```diff and closed with ```. Touch only what is necessary; you MAY add a regression test " +
  "in the same diff. After the block, add these prose sections: `## Root cause`, " +
  "`## Regression test`, `## Uncertainty`, `## Confidence` (one of low/medium/high). If the " +
  "evidence is INSUFFICIENT to propose a safe fix, OMIT the diff entirely and explain in " +
  "`## Uncertainty` what additional information is needed — do NOT invent a fix.";

const SCOPE_RULE =
  "The fix must be minimal and must NOT modify CI configuration (.github/), git hooks (.husky/), " +
  "lockfiles, or unrelated files.";

function systemContent(framework: string): string {
  return [
    "You are a senior engineer performing root-cause analysis on a reported bug.",
    `Test framework: ${framework}.`,
    "Ground your hypothesis in the provided evidence; distinguish what the evidence shows from what you infer.",
    SCOPE_RULE,
    OUTPUT_CONTRACT,
  ].join("\n");
}

function descriptionBlock(description: string | undefined): string {
  return description !== undefined && description.trim().length > 0
    ? `Bug description:\n${description.trim()}`
    : "No free-text description was provided.";
}

function evidenceBlock(report: BugReportInput, evidence: FailureEvidence): string {
  const parts: string[] = [];
  if (report.failingOutput !== undefined && report.failingOutput.trim().length > 0) {
    parts.push(`Failing output:\n${report.failingOutput.trim()}`);
  }
  if (report.stackTrace !== undefined && report.stackTrace.trim().length > 0) {
    parts.push(`Stack trace:\n${report.stackTrace.trim()}`);
  }
  if (evidence.frames.length > 0) {
    const frames = evidence.frames
      .map((frame) =>
        frame.line === undefined ? frame.file : `${frame.file}:${String(frame.line)}`,
      )
      .join(", ");
    parts.push(`Implicated locations: ${frames}`);
  }
  return parts.join("\n\n");
}

function contextBlock(pack: ContextPack): string {
  if (pack.selected.length === 0) {
    return "";
  }
  const entries = pack.selected
    .map((entry) => `--- ${entry.path} ---\n${entry.excerpt}`)
    .join("\n\n");
  return `\n\nRepository context:\n${entries}`;
}

function retryBlock(rejectionReason: string | undefined): string {
  return rejectionReason === undefined
    ? ""
    : `\n\nThe previous diff was rejected: ${rejectionReason}. Produce a corrected, in-scope ` +
        "minimal diff, or omit the diff if no safe fix is possible.";
}

function userContent(
  report: BugReportInput,
  evidence: FailureEvidence,
  pack: ContextPack,
  rejectionReason: string | undefined,
): string {
  const evidenceText = evidenceBlock(report, evidence);
  const evidenceSection = evidenceText.length === 0 ? "" : `\n\n${evidenceText}`;
  return `${descriptionBlock(report.description)}${evidenceSection}${contextBlock(pack)}${retryBlock(rejectionReason)}`;
}

// rejectionReason is appended on a retry (D10) so the model can correct an invalid/out-of-scope
// diff; it is undefined on the first attempt.
export function buildBugPrompt(
  report: BugReportInput,
  evidence: FailureEvidence,
  pack: ContextPack,
  framework: string,
  rejectionReason?: string,
): readonly ChatMessage[] {
  return [
    { role: "system", content: systemContent(framework) },
    { role: "user", content: userContent(report, evidence, pack, rejectionReason) },
  ];
}
