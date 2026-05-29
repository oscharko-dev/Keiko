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
  readonly diff: string;
  readonly rest: string;
}

// Returns the contents of the FIRST fenced block (```diff ... ``` or a bare ``` ... ```) and the
// text after the closing fence. When the content has NO fence AND does not look like a diff, the
// whole content is treated as prose (empty diff) so prose-only investigation output parses cleanly.
function extractFencedDiff(content: string): FenceExtraction {
  const lines = content.split("\n");
  const openIndex = lines.findIndex((line) => line.trimStart().startsWith(FENCE));
  if (openIndex === -1) {
    // No fence: if the content looks like a raw diff, treat it as one; otherwise it is prose.
    return looksLikeDiff(content)
      ? { diff: content.trim(), rest: "" }
      : { diff: "", rest: content };
  }
  const closeIndex = lines.findIndex(
    (line, idx) => idx > openIndex && line.trimStart().startsWith(FENCE),
  );
  if (closeIndex === -1) {
    return {
      diff: lines
        .slice(openIndex + 1)
        .join("\n")
        .trim(),
      rest: "",
    };
  }
  return {
    diff: lines
      .slice(openIndex + 1, closeIndex)
      .join("\n")
      .trim(),
    rest: lines.slice(closeIndex + 1).join("\n"),
  };
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
  const { diff, rest } = extractFencedDiff(content);
  return {
    diff,
    rootCause: extractSection(rest, ROOT_CAUSE_HEADING),
    regressionTestStrategy: extractSection(rest, REGRESSION_HEADING),
    uncertainty: extractSection(rest, UNCERTAINTY_HEADING),
    confidence: parseConfidence(rest),
  };
}
