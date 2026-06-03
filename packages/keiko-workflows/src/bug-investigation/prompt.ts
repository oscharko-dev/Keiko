// Prompt construction (ADR-0009 D9). Builds the system + user ChatMessage array for the single
// investigation call. PURE: no IO, no clock, no randomness — the same inputs always yield the same
// messages. The system message specifies the model-output contract (an OPTIONAL fenced ```diff
// block plus labeled prose sections) that parse.ts consumes, and explicitly tells the model to OMIT
// the diff when evidence is insufficient (the investigation-only outcome, D10). Context excerpts and
// failure messages handed in may originate from CLI/UI input, so every free-text report field is
// redacted and byte-capped before it enters the model prompt.

import { TextDecoder } from "node:util";
import { redact } from "../../gateway/redaction.js";
import type { ChatMessage } from "../../gateway/types.js";
import type { ContextPack } from "../../workspace/index.js";
import type { BugReportInput, FailureEvidence } from "./types.js";

const MAX_PROMPT_TEXT_BYTES = 16_384;
const REDACTION_LOOKAHEAD_BYTES = 512;

const OUTPUT_CONTRACT =
  "Respond with an OPTIONAL minimal fix as a unified diff inside a single fenced code block opened " +
  "with ```diff and closed with ```. Touch only what is necessary; you MAY add a regression test " +
  "in the same diff. For a source-file bug, the diff MUST include at least one non-test source " +
  "change; a regression test alone is NOT a fix and will be rejected. After the block, add these prose sections: `## Root cause`, " +
  "`## Regression test`, `## Uncertainty`, `## Confidence` (one of low/medium/high). If the " +
  "evidence is INSUFFICIENT to propose a safe fix, OMIT the diff entirely and explain in " +
  "`## Uncertainty` what additional information is needed — do NOT invent a fix. When you include " +
  "a diff, the first non-empty line inside the fence MUST be `--- a/<path>` or `--- /dev/null`, " +
  "followed by `+++ b/<path>` and at least one `@@` hunk. Do not output `*** Begin Patch`, file " +
  "trees, prose, or escaped newline markers like `\\n+`/`\\n-` inside the diff fence; every diff " +
  "line must be separated by a real newline. If you include a diff, it must be the FIRST fenced " +
  "code block in the response. Do not include code examples, TypeScript snippets, or alternative " +
  "patches in any other fence; output exactly one diff fence followed by the required prose sections.";

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
  const safe = safePromptText(description);
  return safe !== undefined
    ? `Bug description:\n${safe}`
    : "No free-text description was provided.";
}

function clampToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/�+$/u, "");
  return { text: `${decoded}\n[TRUNCATED]`, truncated: true };
}

function safePromptText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const bounded = clampToBytes(trimmed, MAX_PROMPT_TEXT_BYTES + REDACTION_LOOKAHEAD_BYTES).text;
  return clampToBytes(redact(bounded), MAX_PROMPT_TEXT_BYTES).text;
}

function evidenceBlock(report: BugReportInput, evidence: FailureEvidence): string {
  const parts: string[] = [];
  const failingOutput = safePromptText(report.failingOutput);
  if (failingOutput !== undefined) {
    parts.push(`Failing output:\n${failingOutput}`);
  }
  const stackTrace = safePromptText(report.stackTrace);
  if (stackTrace !== undefined) {
    parts.push(`Stack trace:\n${stackTrace}`);
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
  const safe = safePromptText(rejectionReason);
  return safe === undefined
    ? ""
    : `\n\nThe previous diff was rejected: ${safe}. Produce a corrected, in-scope ` +
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
