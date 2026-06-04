// Defensive parser for the model-output contract (ADR-0008 steering note B). The model is
// instructed (see prompt.ts) to emit the unified diff inside a fenced ```diff ... ``` block,
// optionally followed by labeled prose sections (## Covered behavior, ## Known gaps). This
// parser extracts those parts WITHOUT trusting the model to comply: if no fence is present the
// whole content is treated as the diff; prose sections are extracted only when their headings
// appear. All extraction uses plain string ops (line splitting, startsWith, trim) — zero regex,
// so there is no ReDoS surface (steering note F). Redaction happens at the workflow boundary,
// not here: this module is pure string parsing.

export interface ParsedModelOutput {
  // The proposed unified diff (raw, unredacted). Empty string when no diff content was found.
  readonly diff: string;
  // Prose extracted from the "## Covered behavior" section, if present.
  readonly coveredBehavior: string | undefined;
  // Prose extracted from the "## Known gaps" section, if present.
  readonly knownGaps: string | undefined;
}

const FENCE = "```";
const COVERED_HEADING = "## covered behavior";
const GAPS_HEADING = "## known gaps";

interface FenceExtraction {
  readonly diff: string;
  readonly rest: string;
}

// Returns the contents of the FIRST fenced block (```diff ... ``` or a bare ``` ... ```) and the
// text that follows the closing fence. When no fenced block is found, returns the whole input as
// the diff and an empty remainder (the no-fence fallback).
function extractFencedDiff(content: string): FenceExtraction {
  const lines = content.split("\n");
  const openIndex = lines.findIndex((line) => line.trimStart().startsWith(FENCE));
  if (openIndex === -1) {
    return { diff: content.trim(), rest: "" };
  }
  const closeIndex = lines.findIndex(
    (line, idx) => idx > openIndex && line.trimStart().startsWith(FENCE),
  );
  if (closeIndex === -1) {
    // An opening fence with no close: treat everything after the opener as the diff.
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

// Extracts the body of a labeled section: every line after the matching `## heading` up to the
// next `## ` heading (or end of input). Returns undefined when the heading is absent. Returns
// undefined when the section body is empty after trimming.
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

export function parseModelOutput(content: string): ParsedModelOutput {
  const { diff, rest } = extractFencedDiff(content);
  // Prose may follow the fenced diff; when there is no fence the whole content is the diff and
  // there is no prose to scan, so `rest` is empty and both sections resolve to undefined.
  return {
    diff,
    coveredBehavior: extractSection(rest, COVERED_HEADING),
    knownGaps: extractSection(rest, GAPS_HEADING),
  };
}
