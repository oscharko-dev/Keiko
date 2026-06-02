// Defensive parser for the model-output contract (ADR-0009 D9). The model is instructed (see
// prompt.ts) to emit an OPTIONAL fenced ```diff block followed by labeled prose sections
// `## Root cause`, `## Regression test`, `## Uncertainty`, `## Confidence`. This parser extracts
// those parts WITHOUT trusting the model to comply: a missing diff yields an empty string (a valid
// investigation-only signal, D10) and any missing section yields undefined. All extraction uses
// plain string ops (line splitting, startsWith, trim, toLowerCase) — ZERO regex, so there is no
// ReDoS surface. Redaction happens at the report boundary, not here.

import type { ParsedBugOutput } from "./types.js";

const FENCE = "```";
const ROOT_CAUSE_HEADING = "## root cause";
const REGRESSION_HEADING = "## regression test";
const UNCERTAINTY_HEADING = "## uncertainty";
const CONFIDENCE_HEADING = "## confidence";
const CONFIDENCE_LEVELS: readonly ("low" | "medium" | "high")[] = ["high", "medium", "low"];

interface FenceExtraction {
  readonly diffs: readonly string[];
  readonly rest: string;
}

function isFence(line: string): boolean {
  return line.trimStart().startsWith(FENCE);
}

function isDiffFence(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("```diff") || trimmed.startsWith("```patch");
}

function closeFenceIndex(lines: readonly string[], openIndex: number): number | undefined {
  const closeIndex = lines.findIndex((line, idx) => idx > openIndex && isFence(line));
  return closeIndex === -1 ? undefined : closeIndex;
}

function fenceBody(
  lines: readonly string[],
  openIndex: number,
  closeIndex: number | undefined,
): string {
  const bodyLines =
    closeIndex === undefined ? lines.slice(openIndex + 1) : lines.slice(openIndex + 1, closeIndex);
  return bodyLines.join("\n").trim();
}

function appendNonDiffFence(
  restLines: string[],
  lines: readonly string[],
  openIndex: number,
  closeIndex: number | undefined,
): void {
  restLines.push(
    ...lines.slice(openIndex, closeIndex === undefined ? lines.length : closeIndex + 1),
  );
}

function nextFenceScanIndex(lines: readonly string[], closeIndex: number | undefined): number {
  return closeIndex === undefined ? lines.length : closeIndex + 1;
}

// Returns the contents of the first fenced block that is explicitly a diff/patch fence or whose
// body starts like a unified diff. Other Markdown code examples before the patch are ignored.
// When the content has NO diff fence AND does not look like a diff, the whole content is treated as
// prose (empty diff) so prose-only investigation output parses cleanly.
function extractFencedDiffs(content: string): FenceExtraction {
  const lines = content.split("\n");
  let openIndex = 0;
  const diffs: string[] = [];
  const restLines: string[] = [];
  while (openIndex < lines.length) {
    const line = lines[openIndex] ?? "";
    if (!isFence(line)) {
      restLines.push(line);
      openIndex += 1;
      continue;
    }
    const closeIndex = closeFenceIndex(lines, openIndex);
    const body = fenceBody(lines, openIndex, closeIndex);
    if (isDiffFence(lines[openIndex] ?? "") || looksLikeDiff(body)) {
      diffs.push(body);
    } else {
      appendNonDiffFence(restLines, lines, openIndex, closeIndex);
    }
    openIndex = nextFenceScanIndex(lines, closeIndex);
  }
  if (diffs.length > 0) {
    return { diffs, rest: restLines.join("\n") };
  }
  // No recognised diff fence: if the whole content looks like a raw diff, treat it as one;
  // otherwise it is prose.
  return looksLikeDiff(content)
    ? { diffs: [content.trim()], rest: "" }
    : { diffs: [""], rest: content };
}

// A cheap unfenced-diff heuristic: a unified diff begins with a `diff --git`, `--- `, or `+++ `
// marker. Used only for the no-fence fallback. Plain prefix checks; no regex.
function looksLikeDiff(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("diff --git") || trimmed.startsWith("--- ") || trimmed.startsWith("+++ ")
  );
}

// Extracts the body of a labeled section: lines after the matching `## heading` up to the next
// `## ` heading (or end). Returns undefined when the heading is absent or the body is empty.
function extractSection(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading);
  if (start === -1) {
    return undefined;
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("## ")) {
      break;
    }
    body.push(line);
  }
  const joined = body.join("\n").trim();
  return joined.length === 0 ? undefined : joined;
}

// Parses a confidence level from the section body: the first of high/medium/low it contains
// (lower-cased). Returns undefined when the section is absent or names no known level.
function parseConfidence(rest: string): "low" | "medium" | "high" | undefined {
  const body = extractSection(rest, CONFIDENCE_HEADING);
  if (body === undefined) {
    return undefined;
  }
  const lower = body.toLowerCase();
  return CONFIDENCE_LEVELS.find((level) => lower.includes(level));
}

export function parseBugModelOutput(content: string): ParsedBugOutput {
  return (
    parseBugModelOutputCandidates(content)[0] ?? {
      diff: "",
      rootCause: undefined,
      regressionTestStrategy: undefined,
      uncertainty: undefined,
      confidence: undefined,
    }
  );
}

export function parseBugModelOutputCandidates(content: string): readonly ParsedBugOutput[] {
  const { diffs, rest } = extractFencedDiffs(content);
  const base = {
    rootCause: extractSection(rest, ROOT_CAUSE_HEADING),
    regressionTestStrategy: extractSection(rest, REGRESSION_HEADING),
    uncertainty: extractSection(rest, UNCERTAINTY_HEADING),
    confidence: parseConfidence(rest),
  };
  return diffs.map((diff) => ({
    diff,
    ...base,
  }));
}
