// Shared grounded-answer faithfulness + abstention enforcement (RB-4).
//
// This dependency-light LEAF module is imported by every grounded path (single-source
// `grounded-qa.ts`/`grounded-orchestrator.ts`, multi-source `grounded-qa-multi-source.ts`, and
// hybrid `grounded-qa-hybrid.ts`) so all three inherit identical behavior:
//
//   1. Abstention on empty evidence — `packHasUsableEvidence` / `packsHaveUsableEvidence` let a
//      caller SHORT-CIRCUIT the model call and emit a deterministic no-evidence answer instead of
//      letting the model answer confidently over zero evidence (GEN-AI-GROUNDING-002/-003).
//   2. Citation reconciliation — `reconcileInlineCitations` parses the `[path:line]` markers the
//      GROUNDED_SYSTEM_PROMPT asks the model to emit and checks each against the evidence pack that
//      was ACTUALLY sent to the model. Inline references to files the model never received are
//      surfaced as an `unsupported-citation` uncertainty marker rather than displayed as grounded
//      claims (GEN-AI-GROUNDING-001/-008).
//   3. Truncation surfacing — `incompleteAnswerMarker` turns a `finishReason:"length"` completion
//      into an `incomplete-answer` marker so a cut-off answer is not consumed as final
//      (GEN-AI-GATEWAY-001).
//
// The module deliberately depends only on contract types so it stays a leaf (no import cycle with
// the grounded-qa ⇄ grounded-qa-hybrid pair).

import type {
  ConnectedContextPack,
  LineRange,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts";

// Deterministic no-evidence answer used when the folder/multi-source path abstains BEFORE the
// model call. Kept generic (no scope path) so it is safe to display and speak verbatim.
export const GROUNDED_NO_EVIDENCE_ANSWER =
  "I could not find repository evidence in the connected scope to answer this question. " +
  "No answer is given because there is nothing to ground it in.";

// ─── Evidence-presence predicates ─────────────────────────────────────────────

/** Total excerpt count across every file in the pack. */
export function packExcerptCount(pack: ConnectedContextPack): number {
  return pack.files.reduce((count, file) => count + file.excerpts.length, 0);
}

/**
 * A pack carries usable evidence when at least one file exposes at least one excerpt. This is the
 * SAME condition the local-knowledge/hybrid paths use to decide whether to abstain; the
 * folder/multi-source paths must mirror it (GEN-AI-GROUNDING-002/-003). The real pack assembler adds
 * a `no-evidence` marker exactly when the excerpt count is zero, so keying on the excerpt count is
 * the authoritative signal (a pack with excerpts always has something to ground an answer in).
 */
export function packHasUsableEvidence(pack: ConnectedContextPack): boolean {
  return packExcerptCount(pack) > 0;
}

/** True when at least one of the supplied packs carries usable evidence. */
export function packsHaveUsableEvidence(packs: readonly ConnectedContextPack[]): boolean {
  return packs.some((pack) => packHasUsableEvidence(pack));
}

// ─── Inline citation parsing ──────────────────────────────────────────────────

export interface ParsedInlineCitation {
  readonly raw: string;
  readonly scopePath: string;
  readonly lineRange: LineRange | undefined;
}

// A bracketed token qualifies as a repository citation only when its path segment looks like a real
// repo path: it must contain a `/` or a filename extension, and be built from path-safe characters.
// This is deliberately conservative so ordinary prose brackets (`[1]`, `[TODO]`, `[a, b]`) and
// markdown links (`[text](url)`) are NOT misread as citations.
const BRACKET_RE = /\[([^\]\n]{1,200})\]/g;
const PATH_TOKEN_RE = /^([\w./@+-]+?)(?::(\d+)(?:-(\d+))?)?$/;

function looksLikeRepoPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 180) {
    return false;
  }
  // A markdown-link path opens with `(` — the bracket content is link text, not a citation.
  if (candidate.includes("(") || candidate.includes(")") || candidate.includes(" ")) {
    return false;
  }
  return candidate.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(candidate);
}

function parseCitationLineRange(
  startRaw: string | undefined,
  endRaw: string | undefined,
): LineRange | undefined {
  if (startRaw === undefined) {
    return undefined;
  }
  const startLine = Number.parseInt(startRaw, 10);
  if (!Number.isFinite(startLine)) {
    return undefined;
  }
  const endParsed = endRaw === undefined ? startLine : Number.parseInt(endRaw, 10);
  return { startLine, endLine: Number.isFinite(endParsed) ? endParsed : startLine };
}

function parseCitationToken(token: string): ParsedInlineCitation | undefined {
  const parsed = PATH_TOKEN_RE.exec(token);
  if (parsed === null) {
    return undefined;
  }
  const scopePath = parsed[1] ?? "";
  if (!looksLikeRepoPath(scopePath)) {
    return undefined;
  }
  return { raw: token, scopePath, lineRange: parseCitationLineRange(parsed[2], parsed[3]) };
}

function citationDedupKey(citation: ParsedInlineCitation): string {
  const range =
    citation.lineRange === undefined
      ? "*"
      : `${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
  return `${citation.scopePath}@${range}`;
}

/** Parse the inline `[path:line]` / `[path:start-end]` / `[path]` markers from an answer. */
export function parseInlineCitations(answerText: string): readonly ParsedInlineCitation[] {
  const out: ParsedInlineCitation[] = [];
  const seen = new Set<string>();
  for (const match of answerText.matchAll(BRACKET_RE)) {
    const inner = match[1]?.trim() ?? "";
    // A single bracket may hold several comma-separated refs: `[a.ts:1-2, b.ts:3]`.
    for (const part of inner.split(",")) {
      const citation = parseCitationToken(part.trim());
      if (citation === undefined) {
        continue;
      }
      const dedupKey = citationDedupKey(citation);
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      out.push(citation);
    }
  }
  return out;
}

// ─── Pack index for reconciliation ────────────────────────────────────────────

export interface PackCitationIndex {
  // Every scopePath present as evidence in the pack(s) that reached the model.
  readonly scopePaths: ReadonlySet<string>;
  // Per-path list of excerpt line windows, for optional line-range validation.
  readonly lineWindowsByPath: ReadonlyMap<string, readonly LineRange[]>;
}

/** Build a citation-validation index from the evidence pack(s) that were sent to the model. */
export function buildPackCitationIndex(packs: readonly ConnectedContextPack[]): PackCitationIndex {
  const scopePaths = new Set<string>();
  const lineWindowsByPath = new Map<string, LineRange[]>();
  for (const pack of packs) {
    for (const file of pack.files) {
      if (file.excerpts.length === 0) {
        continue;
      }
      scopePaths.add(file.scopePath);
      const windows = lineWindowsByPath.get(file.scopePath) ?? [];
      for (const excerpt of file.excerpts) {
        if (excerpt.atom.lineRange !== undefined) {
          windows.push(excerpt.atom.lineRange);
        }
      }
      lineWindowsByPath.set(file.scopePath, windows);
    }
  }
  return { scopePaths, lineWindowsByPath };
}

function lineRangeWithinWindows(range: LineRange, windows: readonly LineRange[]): boolean {
  if (windows.length === 0) {
    // Path is in the pack but we have no line window to validate against — accept the path-level
    // match rather than flag a false positive.
    return true;
  }
  return windows.some((w) => range.startLine <= w.endLine && range.endLine >= w.startLine);
}

export interface CitationReconciliation {
  // Inline references whose path is NOT in the evidence pack, or whose line range falls entirely
  // outside every excerpt window for an in-pack path.
  readonly unsupported: readonly ParsedInlineCitation[];
  // Distinct pack scopePaths the answer actually cited (used to distinguish "cited" from
  // "retrieved-but-not-cited" evidence).
  readonly citedScopePaths: ReadonlySet<string>;
}

/**
 * Reconcile an answer's inline citations against the evidence pack(s) sent to the model.
 * Path-level mismatches are the strong signal (the model named a file it never received). A cited
 * line range that is wholly outside every retrieved window for an otherwise-present path is also
 * flagged, but only when the path carries at least one window (so we never over-flag).
 */
export function reconcileInlineCitations(
  answerText: string,
  index: PackCitationIndex,
): CitationReconciliation {
  const unsupported: ParsedInlineCitation[] = [];
  const citedScopePaths = new Set<string>();
  for (const citation of parseInlineCitations(answerText)) {
    if (!index.scopePaths.has(citation.scopePath)) {
      unsupported.push(citation);
      continue;
    }
    if (
      citation.lineRange !== undefined &&
      !lineRangeWithinWindows(
        citation.lineRange,
        index.lineWindowsByPath.get(citation.scopePath) ?? [],
      )
    ) {
      unsupported.push(citation);
      continue;
    }
    citedScopePaths.add(citation.scopePath);
  }
  return { unsupported, citedScopePaths };
}

// ─── Uncertainty marker factories ─────────────────────────────────────────────

/**
 * Build an `unsupported-citation` marker naming the fabricated references, or `undefined` when
 * every inline citation is supported by the pack. Paths are truncated/joined defensively; the
 * marker text is redacted downstream at the wire boundary (`buildUncertainty`).
 */
export function unsupportedCitationMarker(
  unsupported: readonly ParsedInlineCitation[],
  nowMs: number,
): UncertaintyMarker | undefined {
  if (unsupported.length === 0) {
    return undefined;
  }
  const paths = [...new Set(unsupported.map((c) => c.scopePath))].slice(0, 8);
  return {
    kind: "unsupported-citation",
    claim:
      `The answer cited ${paths.length === 1 ? "a source" : "sources"} not present in the ` +
      `retrieved evidence: ${paths.join(", ")}. Treat ${
        paths.length === 1 ? "that claim" : "those claims"
      } as unverified.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

/** Marker for a truncated (finishReason "length") completion. */
export function incompleteAnswerMarker(nowMs: number): UncertaintyMarker {
  return {
    kind: "incomplete-answer",
    claim:
      "The answer was cut off before completion (model output length limit); it may be partial " +
      "or missing supporting evidence.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

/** No-evidence marker used when a path abstains before/without a model call. */
export function noEvidenceMarker(nowMs: number): UncertaintyMarker {
  return {
    kind: "no-evidence",
    claim: "No repository evidence matched the connected scope for this question.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}
