import {
  deriveContextProfile,
  deriveContextProfileFromCapability,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { GatewayCallRequest, ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { splitUnifiedDiffSections } from "../gitDiffParser.js";

export interface CommitDraftDiffEvidence {
  readonly blankChangedLines: number;
  readonly nonBlankChangedLines: number;
  readonly mixedBlankChangeFiles: number;
}

interface DraftHunk {
  readonly lines: string[];
  blankChangedLines: number;
  nonBlankChangedLines: number;
}

const BLANK_CHANGE = /^[+-][\t \r]*$/u;
const END_OF_FILE_MARKER = String.raw`\ No newline at end of file`;

function isTextChange(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

function draftHunks(lines: readonly string[]): {
  readonly headers: readonly string[];
  readonly hunks: readonly DraftHunk[];
} {
  const headers: string[] = [];
  const hunks: DraftHunk[] = [];
  let hunk: DraftHunk | undefined;
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      hunk = {
        lines: [line],
        blankChangedLines: 0,
        nonBlankChangedLines: 0,
      };
      hunks.push(hunk);
      continue;
    }
    if (hunk === undefined) {
      headers.push(line);
      continue;
    }
    hunk.lines.push(line);
    if (BLANK_CHANGE.test(line)) hunk.blankChangedLines += 1;
    else if (isTextChange(line)) hunk.nonBlankChangedLines += 1;
  }
  return { headers, hunks };
}

function nonBlankSide(hunk: DraftHunk, prefix: "-" | "+"): string {
  return hunk.lines
    .filter((line) => line.startsWith(" ") || (line.startsWith(prefix) && !BLANK_CHANGE.test(line)))
    .map((line) => line.slice(1).trimEnd())
    .join("\n");
}

function changesNonBlankContent(hunk: DraftHunk): boolean {
  return nonBlankSide(hunk, "-") !== nonBlankSide(hunk, "+");
}

/** Count edit types while retaining the staged patch as written by Git. */
export function inspectCommitDraftDiff(diff: string): CommitDraftDiffEvidence {
  let blankChangedLines = 0;
  let nonBlankChangedLines = 0;
  let mixedBlankChangeFiles = 0;
  for (const lines of splitUnifiedDiffSections(diff)) {
    const { hunks } = draftHunks(lines);
    const blank = hunks.reduce((total, hunk) => total + hunk.blankChangedLines, 0);
    const nonBlank = hunks.reduce((total, hunk) => total + hunk.nonBlankChangedLines, 0);
    blankChangedLines += blank;
    nonBlankChangedLines += nonBlank;
    if (blank > 0 && hunks.some(changesNonBlankContent)) mixedBlankChangeFiles += 1;
  }
  return { blankChangedLines, nonBlankChangedLines, mixedBlankChangeFiles };
}

/** Shrink context first so that a middle replacement survives in a tight model window. */
function removeDraftDiffContext(lines: readonly string[]): string {
  const { headers, hunks } = draftHunks(lines);
  const edits = hunks.flatMap(({ lines: [header, ...body] }) => [
    header ?? "",
    ...body.filter(
      (line, index) =>
        isTextChange(line) || line === END_OF_FILE_MARKER || body[index + 1] === END_OF_FILE_MARKER,
    ),
  ]);
  return [...headers, ...edits].join("\n");
}

const OMITTED = "\n[Additional diff lines omitted for the model context budget.]\n";

function requestTokens(request: GatewayCallRequest, capability: ModelCapability): number {
  return countGatewayPromptTokens(request, capability.tokenAccounting);
}

function excerpt(section: string, limit: number): string {
  const separator = section.indexOf("\n");
  const header = separator < 0 ? section : section.slice(0, separator);
  const content = separator < 0 ? "" : section.slice(separator + 1);
  if (content.length <= limit) return section;
  if (limit === 0) return header;
  const head = Math.ceil(limit * 0.75);
  const tail = limit - head;
  return (
    header + "\n" + content.slice(0, head) + "\n...\n" + (tail === 0 ? "" : content.slice(-tail))
  );
}

// Allocate each file a share before spending more on a large file. In particular, a lockfile at
// the beginning must never evict the code and tests at the end of a Stage all selection.
function compactDiff(sections: readonly string[], limit: number): string {
  return sections.map((section) => excerpt(section, limit)).join("\n") + OMITTED;
}

export interface PreparedCommitDraft {
  readonly request: GatewayCallRequest | undefined;
  readonly promptTokens: number;
  readonly maxPromptTokens: number;
  readonly diffCompacted: boolean;
  readonly diffEvidence: CommitDraftDiffEvidence;
}

export function prepareCommitDraft(
  diff: string,
  capability: ModelCapability,
  build: (
    diff: string,
    compacted: boolean,
    evidence: CommitDraftDiffEvidence,
  ) => GatewayCallRequest,
): PreparedCommitDraft {
  const diffEvidence = inspectCommitDraftDiff(diff);
  const profile = deriveContextProfileFromCapability(capability);
  const full = build(diff, false, diffEvidence);
  const maxPromptTokens = deriveContextProfile({
    ...profile,
    reservedOutputTokens: full.maxOutputTokens ?? 0,
  }).effectiveInputBudget;
  const prepare = (request: GatewayCallRequest, diffCompacted: boolean): PreparedCommitDraft => ({
    request,
    diffCompacted,
    diffEvidence,
    maxPromptTokens,
    promptTokens: requestTokens(request, capability),
  });
  const original = prepare(full, false);
  if (original.promptTokens <= maxPromptTokens) return original;
  const parsed = splitUnifiedDiffSections(diff).map(removeDraftDiffContext);
  const sections = parsed.length === 0 ? [diff] : parsed;
  let low = 0;
  let high = sections.reduce((largest, section) => Math.max(largest, section.length), 0);
  let selected: PreparedCommitDraft | undefined;
  while (low <= high) {
    const limit = Math.floor((low + high) / 2);
    const candidate = prepare(build(compactDiff(sections, limit), true, diffEvidence), true);
    if (candidate.promptTokens <= maxPromptTokens) {
      selected = candidate;
      low = limit + 1;
    } else high = limit - 1;
  }
  if (selected !== undefined) return selected;
  const minimum = prepare(build(compactDiff(sections, 0), true, diffEvidence), true);
  const refused = minimum.promptTokens < original.promptTokens ? minimum : original;
  return { ...refused, request: undefined };
}

const COMMIT_TRAILER_TOKEN = /^(?:BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)(?::\s+| #)\S/u;
const BREAKING_TRAILER = /^BREAKING(?: CHANGE|-CHANGE):\s/u;
const REFERENCE_TRAILER = /^[A-Za-z][A-Za-z0-9-]*:?[ \t]+#\S/u;
const NAMED_TRAILER = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9-]+:\s/u;

export interface CommitBodyNormalizationEvidence {
  readonly normalizationVersion: "1";
  readonly normalizationRule: "body-only" | "terminal-trailers" | "explicit-trailers";
  readonly normalizationChanged: boolean;
  readonly bodyBulletCount: number;
  readonly trailerLikeLineCount: number;
  readonly trailerCount: number;
  readonly trailerContinuationCount: number;
  readonly trailerParagraphBreakCount: number;
  readonly referenceTrailerCount: number;
  readonly breakingTrailerCount: number;
}

interface CommitTrailerEvidence {
  trailerCount: number;
  trailerContinuationCount: number;
  trailerParagraphBreakCount: number;
  referenceTrailerCount: number;
  breakingTrailerCount: number;
}

function explicitCommitTrailer(text: string): boolean {
  return BREAKING_TRAILER.test(text) || REFERENCE_TRAILER.test(text) || NAMED_TRAILER.test(text);
}

function alignedCommitTrailer(line: string, tokenIndent: number): boolean {
  return COMMIT_TRAILER_TOKEN.test(line.trim()) && line.search(/\S/u) <= tokenIndent;
}

function unindentedParagraph(line: string, boundary: boolean): boolean {
  return boundary && line.trim() !== "" && line === line.trimStart();
}

function commitTrailerStart(lines: readonly string[]): number {
  let start = -1;
  let tokenIndent = Infinity;
  let explicit = false;
  let previousBlank = true;
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    const boundary = previousBlank;
    previousBlank = text === "";
    if (!boundary && start < 0) continue;
    if (alignedCommitTrailer(line, tokenIndent)) {
      if (start < 0) start = index;
      tokenIndent = line.search(/\S/u);
      explicit ||= explicitCommitTrailer(text);
    } else if (!explicit && unindentedParagraph(line, boundary)) {
      // A later body paragraph invalidates earlier ambiguous labels such as Note: or Summary:.
      start = -1;
      tokenIndent = Infinity;
    }
  }
  return start;
}

function normalizeCommitTrailers(lines: readonly string[]): {
  lines: string[];
  evidence: CommitTrailerEvidence;
  explicit: boolean;
} {
  let tokenIndent = lines[0]?.search(/\S/u) ?? 0;
  let explicit = false;
  const evidence = {
    trailerCount: 0,
    trailerContinuationCount: 0,
    trailerParagraphBreakCount: 0,
    referenceTrailerCount: 0,
    breakingTrailerCount: 0,
  };
  const normalized = lines.map((line) => {
    const text = line.trim();
    const indent = line.search(/\S/u);
    if (alignedCommitTrailer(line, tokenIndent)) {
      tokenIndent = indent;
      explicit ||= explicitCommitTrailer(text);
      evidence.trailerCount += 1;
      evidence.referenceTrailerCount += Number(REFERENCE_TRAILER.test(text));
      evidence.breakingTrailerCount += Number(BREAKING_TRAILER.test(text));
      return text;
    }
    if (text === "") evidence.trailerParagraphBreakCount += 1;
    else evidence.trailerContinuationCount += 1;
    return line.trimEnd();
  });
  return { lines: normalized, evidence, explicit };
}

// The model owns the wording; normalize prose into a list while retaining Git trailer syntax.
// Content is never logged here.
export function canonicalCommitBody(body: string): {
  body: string;
  evidence: CommitBodyNormalizationEvidence;
} {
  const lines = body.trim().replace(/\r\n?/gu, "\n").split("\n");
  const trailerLikeLineCount = lines.filter((line) =>
    COMMIT_TRAILER_TOKEN.test(line.trim()),
  ).length;
  const start = commitTrailerStart(lines);
  const trailers = normalizeCommitTrailers(start < 0 ? [] : lines.splice(start));
  const items: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) items.push(`- ${paragraph.join(" ")}`);
    paragraph = [];
  };
  for (const line of lines) {
    const text = line.trim();
    const bullet = /^(?:[-*•]|\d+[.)])\s+/u.exec(text);
    if (text === "" || bullet !== null) flush();
    if (text !== "") paragraph.push(text.slice(bullet?.[0].length ?? 0));
  }
  flush();
  const normalized = [items.join("\n"), trailers.lines.join("\n")]
    .filter((block) => block !== "")
    .join("\n\n");
  const normalizationRule = start < 0 ? "body-only" : "terminal-trailers";
  return {
    body: normalized,
    evidence: {
      normalizationVersion: "1",
      normalizationRule: trailers.explicit ? "explicit-trailers" : normalizationRule,
      normalizationChanged: normalized !== body,
      bodyBulletCount: items.length,
      trailerLikeLineCount,
      ...trailers.evidence,
    },
  };
}
