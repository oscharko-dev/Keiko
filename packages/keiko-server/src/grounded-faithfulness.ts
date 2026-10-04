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
//      claims (GEN-AI-GROUNDING-001/-008). An answer that makes source-backed claims with no
//      supported marker at all is a different defect and carries the distinct `uncited-answer`
//      marker; a refusal ("nothing about this in the documents") carries neither.
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
import {
  CITATION_FINDING_LIST_MAX,
  citationFindingTotalSuffix,
  citationMarkerIndices,
  findCitationMarkerGroups,
  markdownCodeRanges,
  type MarkdownCodeRange,
} from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import { WORKSPACE_PORTABLE_PATH_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import {
  LEGACY_CONNECTED_SEARCH_ABSTENTION,
  isNoEvidenceAnswerText,
} from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
export { connectedSearchNoEvidenceAnswer } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";

// Preserve the legacy source-neutral response for stored answers and historical evaluation
// fixtures. Current folder, multi-source and hybrid producers share the localized builder above.
export const GROUNDED_NO_EVIDENCE_ANSWER = LEGACY_CONNECTED_SEARCH_ABSTENTION;

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
  readonly sourceId?: string;
  readonly scopePath: string;
  readonly lineRange: LineRange | undefined;
}

// A bracketed token qualifies as a repository citation only when its path segment looks like a real
// repo path: it must contain a `/` or a filename extension, and be built from path-safe characters.
// This is deliberately conservative so ordinary prose brackets (`[1]`, `[note]`, `[a, b]`) and
// markdown links (`[text](url)`) are NOT misread as citations.
// The shared path bound plus bounded source ordinal and safe-integer line suffixes.
const CITATION_TOKEN_MAX_CHARS = WORKSPACE_PORTABLE_PATH_MAX_BYTES + 64;
const BRACKET_RE = new RegExp(String.raw`\[([^\]\n]{1,${CITATION_TOKEN_MAX_CHARS}})\]`, "g");
const LINE_RANGE_SUFFIX_RE = /:(\d+)(?:-(\d+))?$/;
const SOURCE_QUALIFIER_RE = /^source:(\d+)\|/u;
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function looksLikeRepoPath(candidate: string): boolean {
  if (
    candidate.length === 0 ||
    candidate.length > WORKSPACE_PORTABLE_PATH_MAX_BYTES ||
    candidate.trim() !== candidate ||
    hasControlCharacter(candidate)
  ) {
    return false;
  }
  if (!isValidScopePath(candidate, { mustBeRelative: true })) {
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
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    return undefined;
  }
  const endParsed = endRaw === undefined ? startLine : Number.parseInt(endRaw, 10);
  if (!Number.isSafeInteger(endParsed) || endParsed < startLine) {
    return undefined;
  }
  return { startLine, endLine: endParsed };
}

function citationTokenSource(token: string): readonly [string | undefined, string] | undefined {
  const qualifier = SOURCE_QUALIFIER_RE.exec(token);
  if (qualifier === null) return [undefined, token];
  const rawSourceId = qualifier[1];
  if (rawSourceId === undefined) return undefined;
  const sourceOrdinal = Number.parseInt(rawSourceId, 10);
  if (!Number.isSafeInteger(sourceOrdinal) || sourceOrdinal < 1) return undefined;
  return [String(sourceOrdinal), token.slice(qualifier[0].length)];
}

function parseCitationToken(token: string): ParsedInlineCitation | undefined {
  const sourcedToken = citationTokenSource(token);
  if (sourcedToken === undefined) return undefined;
  const [sourceId, pathToken] = sourcedToken;
  const rangeSuffix = LINE_RANGE_SUFFIX_RE.exec(pathToken);
  const scopePath = rangeSuffix === null ? pathToken : pathToken.slice(0, rangeSuffix.index);
  if (!looksLikeRepoPath(scopePath)) {
    return undefined;
  }
  const lineRange = parseCitationLineRange(rangeSuffix?.[1], rangeSuffix?.[2]);
  if (rangeSuffix !== null && lineRange === undefined) {
    return undefined;
  }
  return { raw: token, ...(sourceId === undefined ? {} : { sourceId }), scopePath, lineRange };
}

function isMarkdownLink(answerText: string, match: RegExpMatchArray): boolean {
  if (match.index === undefined) return false;
  const next = answerText.charAt(match.index + match[0].length);
  return next === "(" || next === "[";
}

function citationDedupKey(citation: ParsedInlineCitation): string {
  const range =
    citation.lineRange === undefined
      ? "*"
      : `${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
  return `${citation.sourceId ?? "*"}:${citation.scopePath}@${range}`;
}

function skipCompletedCodeRanges(
  code: readonly MarkdownCodeRange[],
  from: number,
  offset: number,
): number {
  let next = from;
  let range = code[next];
  while (range !== undefined && range.end <= offset) {
    next += 1;
    range = code[next];
  }
  return next;
}

function appendBracketCitations(
  inner: string,
  seen: Set<string>,
  out: ParsedInlineCitation[],
): void {
  // A single bracket may hold several comma-separated refs: `[a.ts:1-2, b.ts:3]`.
  for (const part of inner.split(",")) {
    const citation = parseCitationToken(part.trim());
    if (citation === undefined) continue;
    const dedupKey = citationDedupKey(citation);
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      out.push(citation);
    }
  }
}

/** Parse the inline `[path:line]` / `[path:start-end]` / `[path]` markers from an answer. */
export function parseInlineCitations(answerText: string): readonly ParsedInlineCitation[] {
  const out: ParsedInlineCitation[] = [];
  const seen = new Set<string>();
  const code = markdownCodeRanges(answerText);
  let nextCode = 0;
  for (const match of answerText.matchAll(BRACKET_RE)) {
    nextCode = skipCompletedCodeRanges(code, nextCode, match.index);
    if ((code[nextCode]?.start ?? Number.POSITIVE_INFINITY) <= match.index) continue;
    if (isMarkdownLink(answerText, match)) continue;
    appendBracketCitations(match[1]?.trim() ?? "", seen, out);
  }
  return out;
}

export interface NumericCitationReconciliation {
  readonly citedMarkers: ReadonlySet<number>;
  readonly unsupportedMarkers: readonly number[];
}

// The numeric marker grammar is the shared one in keiko-contracts (`findCitationMarkerGroups`), the
// exact parser the citation attacher uses — a reconciler narrower than the attacher cannot see a
// dropped marker, and one parser cannot drift from itself. Grouped markers (`[1, 7, 8]`) expand to
// one index each; an index of zero or below is never a reference.
function parseNumericCitations(answerText: string): readonly number[] {
  return citationMarkerIndices(answerText).filter((marker) => marker > 0);
}

/** Reconcile hybrid `[n]` markers against the exact selected evidence marker set. */
export function reconcileNumericCitations(
  answerText: string,
  supportedMarkers: ReadonlySet<number>,
): NumericCitationReconciliation {
  const citedMarkers = new Set<number>();
  const unsupportedMarkers: number[] = [];
  const seenUnsupported = new Set<number>();
  // Every index of every marker group outside Markdown code counts, a grouped one included: a
  // fabricated `[9, 10]` beside a real `[1]` is a dangling source attribution, never content
  // (PR #3678 review, P1).
  for (const marker of parseNumericCitations(answerText)) {
    if (supportedMarkers.has(marker)) {
      citedMarkers.add(marker);
    } else if (!seenUnsupported.has(marker)) {
      seenUnsupported.add(marker);
      unsupportedMarkers.push(marker);
    }
  }
  return { citedMarkers, unsupportedMarkers };
}

// ─── Pack index for reconciliation ────────────────────────────────────────────

export interface PackCitationIndex {
  // Every scopePath present as evidence in the pack(s) that reached the model.
  readonly scopePaths: ReadonlySet<string>;
  // Source identities carrying each path. More than one entry makes an unqualified marker
  // ambiguous and therefore unsupported.
  readonly sourceIdsByPath: ReadonlyMap<string, ReadonlySet<string>>;
  // Line windows stay partitioned by source identity. They must never be joined across roots.
  readonly lineWindowsBySourceId: ReadonlyMap<string, ReadonlyMap<string, readonly LineRange[]>>;
}

export function citationSourceIdForIndex(index: number): string {
  return String(index + 1);
}

function indexPackEvidence(
  pack: ConnectedContextPack,
  sourceId: string,
  scopePaths: Set<string>,
  sourceIdsByPath: Map<string, Set<string>>,
  lineWindowsByPath: Map<string, LineRange[]>,
): void {
  for (const file of pack.files) {
    if (file.excerpts.length === 0) continue;
    scopePaths.add(file.scopePath);
    const sourceIds = sourceIdsByPath.get(file.scopePath) ?? new Set<string>();
    sourceIds.add(sourceId);
    sourceIdsByPath.set(file.scopePath, sourceIds);
    const windows = lineWindowsByPath.get(file.scopePath) ?? [];
    for (const excerpt of file.excerpts) {
      if (excerpt.atom.lineRange !== undefined) windows.push(excerpt.atom.lineRange);
    }
    lineWindowsByPath.set(file.scopePath, windows);
  }
}

/** Build a source-partitioned citation index from the packs that were sent to the model. */
export function buildPackCitationIndex(packs: readonly ConnectedContextPack[]): PackCitationIndex {
  const scopePaths = new Set<string>();
  const sourceIdsByPath = new Map<string, Set<string>>();
  const lineWindowsBySourceId = new Map<string, Map<string, LineRange[]>>();
  for (const [index, pack] of packs.entries()) {
    const sourceId = citationSourceIdForIndex(index);
    const lineWindowsByPath = new Map<string, LineRange[]>();
    indexPackEvidence(pack, sourceId, scopePaths, sourceIdsByPath, lineWindowsByPath);
    lineWindowsBySourceId.set(sourceId, lineWindowsByPath);
  }
  return { scopePaths, sourceIdsByPath, lineWindowsBySourceId };
}

function lineRangeWithinWindows(range: LineRange, windows: readonly LineRange[]): boolean {
  if (windows.length === 0) {
    // The path itself is evidence, but no exact line location reached the model. Accepting an
    // arbitrary model-supplied line here would turn an unverified location into a precise source.
    return false;
  }
  let nextLine = range.startLine;
  const ordered = [...windows].sort(
    (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
  );
  for (const window of ordered) {
    if (window.endLine < nextLine) continue;
    if (window.startLine > nextLine) return false;
    if (window.endLine >= range.endLine) return true;
    nextLine = window.endLine + 1;
  }
  return false;
}

function resolveCitationSourceId(
  citation: ParsedInlineCitation,
  sourceIdsByPath: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  const sourceIds = sourceIdsByPath.get(citation.scopePath);
  if (sourceIds === undefined || sourceIds.size === 0) return undefined;
  if (citation.sourceId !== undefined) {
    return sourceIds.has(citation.sourceId) ? citation.sourceId : undefined;
  }
  if (sourceIds.size !== 1) return undefined;
  return sourceIds.values().next().value;
}

/** Resolve a marker only when source identity and requested precision are supported by evidence. */
export function resolveSupportedCitationSourceId(
  citation: ParsedInlineCitation,
  index: PackCitationIndex,
): string | undefined {
  const sourceId = resolveCitationSourceId(citation, index.sourceIdsByPath);
  if (sourceId === undefined) return undefined;
  if (citation.lineRange === undefined) return sourceId;
  const windows = index.lineWindowsBySourceId.get(sourceId)?.get(citation.scopePath) ?? [];
  return lineRangeWithinWindows(citation.lineRange, windows) ? sourceId : undefined;
}

export interface CitationReconciliation {
  // Inline references whose path is NOT in the evidence pack, or whose line range is not fully
  // contained by an excerpt window for an in-pack path.
  readonly unsupported: readonly ParsedInlineCitation[];
  // Distinct pack scopePaths the answer actually cited (used to distinguish "cited" from
  // "retrieved-but-not-cited" evidence).
  readonly citedScopePaths: ReadonlySet<string>;
}

/**
 * Reconcile an answer's inline citations against the evidence pack(s) sent to the model.
 * Path-level mismatches are the strong signal (the model named a file it never received). A cited
 * line range is also flagged unless the retrieved windows fully cover it. Bare path citations stay
 * valid for path-level evidence; only unsupported precision fails closed.
 */
export function reconcileInlineCitations(
  answerText: string,
  index: PackCitationIndex,
): CitationReconciliation {
  const unsupported: ParsedInlineCitation[] = [];
  const citedScopePaths = new Set<string>();
  for (const citation of parseInlineCitations(answerText)) {
    if (resolveSupportedCitationSourceId(citation, index) === undefined) {
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
  const allPaths = [...new Set(unsupported.map((c) => c.scopePath))];
  const paths = allPaths.slice(0, CITATION_FINDING_LIST_MAX);
  return {
    kind: "unsupported-citation",
    claim:
      `The answer cited ${paths.length === 1 ? "a source" : "sources"} not present in the ` +
      `retrieved evidence: ${paths.join(", ")}. ` +
      `Treat ${paths.length === 1 ? "that claim" : "those claims"} as unverified.` +
      citationFindingTotalSuffix(allPaths.length),
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

/** Build a body-free marker for hybrid `[n]` citations absent from selected evidence. */
export function unsupportedNumericCitationMarker(
  unsupportedMarkers: readonly number[],
  nowMs: number,
): UncertaintyMarker | undefined {
  if (unsupportedMarkers.length === 0) return undefined;
  const distinct = [...new Set(unsupportedMarkers)];
  const markers = distinct
    .slice(0, CITATION_FINDING_LIST_MAX)
    .map((marker) => `[${String(marker)}]`);
  return {
    kind: "unsupported-citation",
    claim:
      `The answer cited ${markers.length === 1 ? "an evidence marker" : "evidence markers"} ` +
      `not present in the retrieved evidence: ${markers.join(", ")}. Treat the affected claims ` +
      `as unverified.${citationFindingTotalSuffix(distinct.length)}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

/**
 * Body-free warning for a source-backed answer that contains no supported citation at all. Kind
 * `uncited-answer`, NOT `unsupported-citation`: nothing was fabricated or out of range — the answer
 * just does not say where its claims come from, and the reader-facing wording must not claim that
 * it "references sources that were not in the retrieved evidence".
 */
export function missingCitationMarker(nowMs: number): UncertaintyMarker {
  return {
    kind: "uncited-answer",
    claim:
      "The answer used retrieved evidence without a supported inline citation. Treat its " +
      "source-backed claims as unverified.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

/**
 * The missing-citation warning for a concrete answer text, or `undefined` when the answer is a
 * refusal ("nothing about this in the documents"). A refusal makes no source-backed claim, so there
 * is nothing to cite and nothing to warn about; the shared detector lives in keiko-contracts.
 */
export function missingCitationMarkerFor(
  answerText: string,
  nowMs: number,
): UncertaintyMarker | undefined {
  return isNoEvidenceAnswerText(answerText) ? undefined : missingCitationMarker(nowMs);
}

/**
 * Body-free uncertainty for a grounded answer that received governed memory outside the evidence
 * pack. A valid repository citation does not authenticate a separate memory-derived assertion, so
 * those claims are uncited (`uncited-answer`) — they cite no fabricated source.
 */
export function uncitedMemoryContextMarker(nowMs: number): UncertaintyMarker {
  return {
    kind: "uncited-answer",
    claim:
      "The answer received governed memory context outside retrieved evidence. Treat claims " +
      "derived from that memory as uncited and unverified.",
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
    claim: "No evidence matched the connected scope for this question.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

// ─── Entailment (citation-support) verification (Knowledge M1.2 / Issue #2563) ──
//
// Membership reconciliation above answers "was this citation in the pack?". The entailment stage
// answers the harder question "does the cited excerpt actually SUPPORT the claim?" — upgrading the
// moat from citation membership to citation support. It runs STRICTLY AFTER membership and ONLY over
// citations that passed membership, so a fabricated (out-of-pack) citation is never double-reported.
//
// The judge is a PORT. Production routes it through the Model Gateway (grounded-entailment-judge.ts);
// the CI gate (grounded-entailment-eval.ts) scores THIS EXACT segmentation/reconciliation/marker
// logic with a deterministic scripted judge — which is what makes `check:grounded-entailment`
// non-tautological (a pass-through judge must let the unsupported fixture through, failing the gate).
// This leaf stays contracts-only: it defines the port, never the gateway call.

/**
 * A per-claim entailment verdict. `unavailable` is a first-class discriminant — the judge could not
 * decide (gateway down, timeout, unparseable output, budget exhausted) — and is NEVER collapsed into
 * `supported`. Fail-closed: an undecidable claim surfaces a caveat, it is not silently trusted.
 */
export type EntailmentVerdict = "supported" | "unsupported" | "unavailable";

export interface EntailmentJudgeInput {
  readonly claimText: string;
  readonly excerptText: string;
}

/**
 * The entailment judge port. Async because the production implementation is a Model Gateway call;
 * the deterministic eval implements the SAME port with no network. Implementations MUST fail closed
 * to `unavailable` (never throw, never default to `supported`).
 */
export interface EntailmentJudge {
  readonly judge: (input: EntailmentJudgeInput, signal?: AbortSignal) => Promise<EntailmentVerdict>;
}

/** A sentence-level span of the answer paired with the inline citations it carries. */
export interface CitedClaim {
  readonly claimText: string;
  readonly citations: readonly ParsedInlineCitation[];
  /** Present when the stripper removed bracketed prose from the claim (see NumericCitedClaim). */
  readonly hidesProse?: true;
}

/** Per-answer bounds so the judge is never invoked unboundedly. */
export interface EntailmentOptions {
  // Upper bound on claims submitted to the judge for one answer. Cited claims beyond the ceiling
  // are NOT dropped: like the wall-clock budget below they are counted `unavailable`, so a long
  // answer degrades to the entailment-unavailable caveat instead of rendering its untested tail as
  // verified (#2670 AC6).
  readonly maxClaims: number;
  // Per evidence item (one cited excerpt), not per claim — see ENTAILMENT_MAX_EVIDENCE_ITEMS_PER_CLAIM.
  readonly maxExcerptChars: number;
  // Stage-wide wall-clock budget for the whole entailment pass. Once it (or the caller signal) is
  // exhausted, no further judge calls are made and any remaining claims are counted `unavailable`
  // (surfaced as the entailment-unavailable marker) — so a slow model degrades the answer instead of
  // stacking `maxClaims` sequential judge timeouts into minutes of tail latency.
  readonly maxTotalMs: number;
}

// One claim may cite several evidence items ("[1, 7, 8]"). `maxExcerptChars` bounds EACH item (the
// producers already capped every excerpt at the grounding excerpt limit before it was shown to the
// answer model), and this ceiling bounds how many distinct items one judge call may carry, so the
// judge input stays bounded at items x per-item cap. A claim citing more distinct items than this is
// undecidable (counted `unavailable`), never judged against a subset of its evidence.
export const ENTAILMENT_MAX_EVIDENCE_ITEMS_PER_CLAIM = 8;

// A numeric `[n]` evidence item is the prompt-rendered block, not the bare excerpt: an `[n] <label>`
// header (the label is capped at 512 characters upstream) plus a code fence around the excerpt. That
// framing is not excerpt text, so it must not count against `maxExcerptChars` — before this
// allowance a single excerpt at the cap could never fit its own block and EVERY normally cited claim
// degraded to the "citation support could not be verified" caveat.
export const NUMERIC_EVIDENCE_FRAMING_CHARS = 1_024;

export const DEFAULT_ENTAILMENT_OPTIONS: EntailmentOptions = {
  // Lowered from 24: bounds the sequential judge fan-out per answer while still covering the cited
  // claims of a typical grounded answer.
  maxClaims: 8,
  maxExcerptChars: 900,
  maxTotalMs: 20_000,
};

/** Mutable per-answer allowance shared by every citation grammar judged for that answer. */
export interface EntailmentExecutionBudget {
  readonly signal: AbortSignal | undefined;
  remainingClaims: number;
}

function isSentenceBoundary(text: string, offset: number): boolean {
  const ch = text.charAt(offset);
  if (ch === "!" || ch === "?" || ch === "\n") return true;
  if (ch !== ".") return false;
  const next = text.charAt(offset + 1);
  return next.length === 0 || /\s/u.test(next);
}

const OPEN_CITATION_BRACKETS: ReadonlySet<string> = new Set(["[", "［", "【"]);
const CLOSE_CITATION_BRACKETS: ReadonlySet<string> = new Set(["]", "］", "】"]);

function citationBracketDepth(depth: number, character: string): number {
  if (OPEN_CITATION_BRACKETS.has(character)) return depth + 1;
  if (CLOSE_CITATION_BRACKETS.has(character)) return Math.max(0, depth - 1);
  return depth;
}

/**
 * Split answer text into sentence-level spans, bracket-aware so a `.` inside a `[routes.ts:5]`
 * citation never splits mid-citation. A span ends at `.`/`!`/`?`/newline only at bracket depth 0.
 */
export function splitClaimSpans(text: string): readonly string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const nextDepth = citationBracketDepth(depth, ch);
    if (nextDepth !== depth) {
      depth = nextDepth;
      continue;
    }
    if (depth !== 0 || !isSentenceBoundary(text, i)) continue;
    const span = text.slice(start, i + 1);
    if (span.trim().length > 0) spans.push(span);
    start = i + 1;
  }
  if (text.slice(start).trim().length > 0) {
    spans.push(text.slice(start));
  }
  return spans;
}

// Every bracketed span the claim stripper removes, a citation or not.
const CLAIM_BRACKET_RE = new RegExp(
  String.raw`[[［【][^\]］】\n]{1,${CITATION_TOKEN_MAX_CHARS}}[\]］】]`,
  "g",
);

/** Remove inline `[...]` citation brackets from a claim span so the judge sees the prose claim. */
export function stripInlineCitations(text: string): string {
  return text
    .replace(CLAIM_BRACKET_RE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// A bracket whose every part is a path citation hides no prose: adjacent citations
// `[a.ts:1][b.ts:2]` are two citations. An inline link's label is visible prose however path-like
// it reads (`[MFA / anonymous denied](https://…)`), so a bracket followed by `(` is never one
// (PR #3678 review).
function isPathCitationBracket(span: string, match: RegExpMatchArray): boolean {
  if (span.charAt((match.index ?? 0) + match[0].length) === "(") return false;
  const inner = match[0].slice(1, -1);
  return inner.split(",").every((part) => parseCitationToken(part.trim()) !== undefined);
}

// True when the stripper removes bracketed text that is not a citation marker: prose such as
// `[The repository enforces MFA]` or a link label that the reader sees and the judge never reads.
function hidesBracketedProse(span: string): boolean {
  const markerStarts = new Set(findCitationMarkerGroups(span).map((group) => group.start));
  return [...span.matchAll(CLAIM_BRACKET_RE)].some(
    (match) => !markerStarts.has(match.index) && !isPathCitationBracket(span, match),
  );
}

/** Segment an answer into the cited claims (spans that carry at least one inline citation). */
export function segmentCitedClaims(answerText: string): readonly CitedClaim[] {
  const claims: CitedClaim[] = [];
  for (const span of splitClaimSpans(answerText)) {
    const citations = parseInlineCitations(span);
    if (citations.length > 0) {
      const claimText = stripInlineCitations(span);
      claims.push(
        hidesBracketedProse(span)
          ? { claimText, citations, hidesProse: true }
          : { claimText, citations },
      );
    }
  }
  return claims;
}

export interface NumericCitedClaim {
  readonly claimText: string;
  readonly markers: readonly number[];
  /**
   * Present when the claim's span(s) carried bracketed prose the stripper removed: the judge reads
   * `claimText` only, so its verdict does not cover everything the reader sees (PR #3678 review).
   */
  readonly hidesProse?: true;
}

interface NumericClaimDraft {
  claimText: string;
  readonly markers: Set<number>;
  hidesProse: boolean;
}

// A span that continues the last cited claim extends that claim in place: it keeps the earlier
// markers, so the judge reads the whole visible claim against every excerpt cited for it, never one
// part of it against another part's source alone. The marker union grows incrementally, so a hostile
// run of continuations stays linear (PR #3678 review).
function appendNumericCitedClaim(
  drafts: NumericClaimDraft[],
  continued: NumericClaimDraft | undefined,
  supported: SupportedClaimText,
  markers: readonly number[],
): NumericClaimDraft {
  if (continued === undefined) {
    const draft = {
      claimText: supported.text,
      markers: new Set(markers),
      hidesProse: supported.hidesProse,
    };
    drafts.push(draft);
    return draft;
  }
  continued.claimText = supported.text;
  for (const marker of markers) continued.markers.add(marker);
  continued.hidesProse ||= supported.hidesProse;
  return continued;
}

function numericCitedClaimOf(draft: NumericClaimDraft): NumericCitedClaim {
  const markers = [...draft.markers];
  return draft.hidesProse
    ? { claimText: draft.claimText, markers, hidesProse: true }
    : { claimText: draft.claimText, markers };
}

/** Segment user-visible `[n]` citations against the sentence each marker actually supports. */
interface SupportedClaimText {
  readonly text: string;
  readonly hidesProse: boolean;
}

// A span with a letter or a digit is a claim of its own; an ordered-list number alone ("1." of
// `1. [1]`) is not. Any other span (punctuation, Markdown syntax, a bare symbol such as `>>` or `~`)
// continues the claim before it: the judge reads that claim with the span's visible residue
// appended, and the claim keeps every hidden prose seen since. Nothing visible is dropped and no
// hidden prose is lost, whatever syntax the renderer gives the residue (PR #3678 review).
const OWN_CLAIM_TEXT = /[\p{L}\p{N}]/u;
const LIST_NUMBER_ONLY = /^\d{1,9}[.)]$/u;
const PUNCTUATION_ONLY = /^[\s.,;:!?…]*$/u;

function isOwnClaimText(claimText: string): boolean {
  return OWN_CLAIM_TEXT.test(claimText) && !LIST_NUMBER_ONLY.test(claimText.trim());
}

// The claim a span's markers support. A marker with no claim before it supports its own residue,
// or, when its span only hides prose, an empty hidden claim the judge can never decide.
function supportedClaimOf(
  claimText: string,
  hidden: boolean,
  preceding: SupportedClaimText | undefined,
): SupportedClaimText | undefined {
  if (isOwnClaimText(claimText)) return { text: claimText, hidesProse: hidden };
  const residue = PUNCTUATION_ONLY.test(claimText) ? "" : claimText.trim();
  if (preceding !== undefined) {
    const text = residue.length === 0 ? preceding.text : `${preceding.text} ${residue}`;
    return { text, hidesProse: preceding.hidesProse || hidden };
  }
  if (residue.length > 0) return { text: residue, hidesProse: hidden };
  return hidden ? { text: "", hidesProse: true } : undefined;
}

export function segmentNumericCitedClaims(answerText: string): readonly NumericCitedClaim[] {
  const drafts: NumericClaimDraft[] = [];
  let preceding: SupportedClaimText | undefined;
  // The claim the preceding span cited or continued: a span without claim text of its own extends it.
  let lastClaim: NumericClaimDraft | undefined;
  for (const span of splitClaimSpans(answerText)) {
    const markers = parseNumericCitations(span);
    const claimText = stripInlineCitations(span);
    const supported = supportedClaimOf(claimText, hidesBracketedProse(span), preceding);
    if (supported !== undefined) {
      const continued = isOwnClaimText(claimText) ? undefined : lastClaim;
      lastClaim =
        markers.length > 0
          ? appendNumericCitedClaim(drafts, continued, supported, markers)
          : continued;
      // An uncited span of bracketed prose alone still hides that prose: from the claim it follows,
      // or, at the start, from the marker that cites it later (PR #3678 review).
      preceding = supported;
    }
  }
  return drafts.map(numericCitedClaimOf);
}

/** A claim whose cited excerpt(s) did NOT support it (verdict `unsupported`). */
export interface UnentailedClaim {
  readonly citedPaths: readonly string[];
}

export interface EntailmentReconciliation {
  // Claims the judge decided are NOT supported by their cited excerpt.
  readonly unentailed: readonly UnentailedClaim[];
  // Count of claims actually submitted to the judge (bounded by maxClaims).
  readonly judgedClaims: number;
  // Count of claims the judge could not decide (verdict `unavailable`).
  readonly unavailableClaims: number;
  // Of those, the claims never sent to the judge because the claim stripper removed bracketed prose
  // the reader sees: the judge would read only part of the claim (PR #3678 review, P1). Absent at 0.
  readonly hiddenProseClaims?: number;
}

/** Resolve the bounded excerpt text for a membership-valid citation, or `undefined` if none. */
export type ExcerptTextResolver = (citation: ParsedInlineCitation) => string | undefined;

/** Evidence selected and rendered for one numeric `[n]` connector citation. */
export interface NumericEntailmentEvidence {
  readonly marker: number;
  readonly excerptText: string;
}

interface EntailmentClaimEvidence {
  readonly citedPath: string;
  readonly excerptText: string | undefined;
  // Characters of the text that are rendering frame rather than excerpt (numeric blocks only).
  readonly framingChars?: number;
}

interface EntailmentClaim {
  readonly claimText: string;
  readonly evidence: readonly EntailmentClaimEvidence[];
  readonly hidesProse?: true;
}

// A claim the judge would read only in part is undecidable, whatever its lexical overlap: it is
// counted unavailable and never judged (fail closed), so `The API uses TLS [MFA mandatory] [1]`
// cannot pass on its TLS half.
function claimForJudge(
  claimText: string,
  evidence: readonly EntailmentClaimEvidence[],
  hidesProse: true | undefined,
): readonly EntailmentClaim[] {
  if (evidence.length === 0) return [];
  return [hidesProse === true ? { claimText, evidence, hidesProse } : { claimText, evidence }];
}

interface CollectedExcerptText {
  readonly text: string;
  // True when the judge could not be shown ALL of the cited evidence: one item is longer than the
  // per-item cap, or more distinct items are cited than one judge call may carry. The judge then
  // never sees part of the cited evidence, so a claim whose contradiction sits in the unseen part
  // must not be judged against the rest (see `judgeableClaimFor`).
  readonly truncated: boolean;
}

function collectExcerptText(
  evidence: readonly EntailmentClaimEvidence[],
  maxExcerptChars: number,
): CollectedExcerptText {
  const seen = new Set<string>();
  const parts: string[] = [];
  let itemTooLong = false;
  for (const item of evidence) {
    const text = item.excerptText?.trim();
    if (text === undefined || text.length === 0 || seen.has(text)) {
      continue;
    }
    seen.add(text);
    parts.push(text);
    itemTooLong ||= text.length > maxExcerptChars + (item.framingChars ?? 0);
  }
  return {
    text: parts.join("\n\n"),
    truncated: itemTooLong || parts.length > ENTAILMENT_MAX_EVIDENCE_ITEMS_PER_CLAIM,
  };
}

// `submittedToJudge` distinguishes a real judge call from every fail-closed "unavailable" that
// never reaches the judge (empty excerpt, truncated excerpt) — `judgedClaims` below must count only
// the former, or the entailment-stage diagnostic ("unavailable for X of Y judged claims") reports
// judge activity that never happened.
interface JudgeableClaim {
  readonly claimText: string;
  readonly excerptText: string;
  readonly citedPaths: readonly string[];
}

function judgeableClaimFor(
  claim: EntailmentClaim,
  maxExcerptChars: number,
): JudgeableClaim | undefined {
  const { text: excerptText, truncated } = collectExcerptText(claim.evidence, maxExcerptChars);
  if (excerptText.length === 0 || claim.claimText.length === 0) {
    // No usable excerpt/claim text to judge against — undecidable, never assumed supported.
    return undefined;
  }
  if (truncated) {
    // The judge could not be shown all of the cited evidence, exactly like an exhausted
    // maxClaims/maxTotalMs budget — count it unavailable rather than risk a "supported" verdict
    // that never saw the evidence past the cut.
    return undefined;
  }
  return {
    claimText: claim.claimText,
    excerptText,
    citedPaths: [...new Set(claim.evidence.map((item) => item.citedPath))],
  };
}

async function verdictForJudgeableClaim(
  claim: JudgeableClaim,
  judge: EntailmentJudge,
  signal: AbortSignal | undefined,
): Promise<EntailmentVerdict> {
  return judge.judge({ claimText: claim.claimText, excerptText: claim.excerptText }, signal);
}

/**
 * Judge, per cited claim, whether its MEMBERSHIP-VALID citations' excerpts support the claim.
 * Only citations absent from `membership.unsupported` are judged (so membership failures are never
 * re-reported as entailment failures). Bounded by `options`. The judge port decides each verdict;
 * `unavailable` verdicts are counted, never treated as supported.
 */
// Combine the stage-wide deadline with any caller signal into one budget signal. Returns the caller
// signal unchanged when there is no positive time budget (opt-out), preserving unbounded behavior.
function entailmentBudgetSignal(
  maxTotalMs: number,
  signal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (maxTotalMs <= 0) {
    return signal;
  }
  const deadline = AbortSignal.timeout(maxTotalMs);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

export function createEntailmentExecutionBudget(
  options: EntailmentOptions,
  signal?: AbortSignal,
): EntailmentExecutionBudget {
  return {
    signal: entailmentBudgetSignal(options.maxTotalMs, signal),
    remainingClaims: Math.max(0, options.maxClaims),
  };
}

interface ScheduledClaim {
  readonly claim: JudgeableClaim;
  readonly verdict: Promise<EntailmentVerdict>;
}

function scheduleClaimJudges(
  claims: readonly EntailmentClaim[],
  judge: EntailmentJudge,
  options: EntailmentOptions,
  budget: AbortSignal | undefined,
): { readonly scheduled: readonly ScheduledClaim[]; readonly unavailableClaims: number } {
  let unavailableClaims = 0;
  const scheduled: ScheduledClaim[] = [];
  for (const claim of claims) {
    if (scheduled.length >= options.maxClaims || budget?.aborted === true) {
      unavailableClaims += 1;
      continue;
    }
    const judgeable = judgeableClaimFor(claim, options.maxExcerptChars);
    if (judgeable === undefined) {
      unavailableClaims += 1;
      continue;
    }
    scheduled.push({
      claim: judgeable,
      verdict: verdictForJudgeableClaim(judgeable, judge, budget),
    });
  }
  return { scheduled, unavailableClaims };
}

async function reconcileEntailmentClaims(
  claims: readonly EntailmentClaim[],
  judge: EntailmentJudge,
  options: EntailmentOptions,
  signal: AbortSignal | undefined,
  executionBudget?: EntailmentExecutionBudget,
): Promise<EntailmentReconciliation> {
  const budget = executionBudget ?? createEntailmentExecutionBudget(options, signal);
  const boundedOptions = {
    ...options,
    maxClaims: Math.min(options.maxClaims, budget.remainingClaims),
  };
  const unentailed: UnentailedClaim[] = [];
  const hiddenProseClaims = claims.filter((claim) => claim.hidesProse === true).length;
  const scheduledClaims = scheduleClaimJudges(
    claims.filter((claim) => claim.hidesProse !== true),
    judge,
    boundedOptions,
    budget.signal,
  );
  budget.remainingClaims -= scheduledClaims.scheduled.length;
  let unavailableClaims = scheduledClaims.unavailableClaims + hiddenProseClaims;
  const { scheduled } = scheduledClaims;
  const outcomes = await Promise.all(scheduled.map(({ verdict }) => verdict));
  for (const [index, outcome] of outcomes.entries()) {
    const claim = scheduled[index];
    if (claim === undefined) continue;
    if (outcome === "unsupported") {
      unentailed.push({ citedPaths: claim.claim.citedPaths });
    } else if (outcome === "unavailable") {
      unavailableClaims += 1;
    }
  }
  return {
    unentailed,
    judgedClaims: scheduled.length,
    unavailableClaims,
    ...(hiddenProseClaims > 0 ? { hiddenProseClaims } : {}),
  };
}

function inlineEntailmentClaims(
  answerText: string,
  membership: CitationReconciliation,
  resolveExcerptText: ExcerptTextResolver,
): readonly EntailmentClaim[] {
  const membershipFailed = new Set(membership.unsupported.map(citationDedupKey));
  return segmentCitedClaims(answerText).flatMap((claim): readonly EntailmentClaim[] => {
    const evidence = claim.citations
      .filter((citation) => !membershipFailed.has(citationDedupKey(citation)))
      .map((citation) => ({
        citedPath: citation.scopePath,
        excerptText: resolveExcerptText(citation),
      }));
    return claimForJudge(claim.claimText, evidence, claim.hidesProse);
  });
}

export async function reconcileClaimEntailment(
  answerText: string,
  membership: CitationReconciliation,
  resolveExcerptText: ExcerptTextResolver,
  judge: EntailmentJudge,
  options: EntailmentOptions = DEFAULT_ENTAILMENT_OPTIONS,
  signal?: AbortSignal,
  executionBudget?: EntailmentExecutionBudget,
): Promise<EntailmentReconciliation> {
  return reconcileEntailmentClaims(
    inlineEntailmentClaims(answerText, membership, resolveExcerptText),
    judge,
    options,
    signal,
    executionBudget,
  );
}

/**
 * Judge numeric connector citations against the exact selected evidence that rendered their `[n]`
 * markers. Unknown, malformed, and non-positive markers remain membership failures and are never
 * promoted into semantic evidence.
 */
export async function reconcileNumericClaimEntailment(
  answerText: string,
  selectedEvidence: readonly NumericEntailmentEvidence[],
  judge: EntailmentJudge,
  options: EntailmentOptions = DEFAULT_ENTAILMENT_OPTIONS,
  signal?: AbortSignal,
  executionBudget?: EntailmentExecutionBudget,
): Promise<EntailmentReconciliation> {
  const evidenceByMarker = new Map<number, NumericEntailmentEvidence>();
  for (const evidence of selectedEvidence) {
    if (Number.isSafeInteger(evidence.marker) && evidence.marker > 0) {
      evidenceByMarker.set(evidence.marker, evidence);
    }
  }
  const claims = segmentNumericCitedClaims(answerText).flatMap(
    (claim): readonly EntailmentClaim[] => {
      const evidence = claim.markers.flatMap((marker): readonly EntailmentClaimEvidence[] => {
        const selected = evidenceByMarker.get(marker);
        return selected === undefined
          ? []
          : [
              {
                citedPath: `[${String(selected.marker)}]`,
                excerptText: selected.excerptText,
                framingChars: NUMERIC_EVIDENCE_FRAMING_CHARS,
              },
            ];
      });
      return claimForJudge(claim.claimText, evidence, claim.hidesProse);
    },
  );
  return reconcileEntailmentClaims(claims, judge, options, signal, executionBudget);
}

/**
 * Build an `unsupported-claim` marker naming the cited paths whose excerpts did not support their
 * claim, or `undefined` when every judged claim was supported. Body-free: the marker names the
 * `path:line`-level source (already visible in the answer) but NEVER quotes the claim or excerpt.
 */
export function unsupportedClaimMarker(
  unentailed: readonly UnentailedClaim[],
  nowMs: number,
): UncertaintyMarker | undefined {
  if (unentailed.length === 0) {
    return undefined;
  }
  const paths = [...new Set(unentailed.flatMap((c) => c.citedPaths))].slice(
    0,
    CITATION_FINDING_LIST_MAX,
  );
  const single = unentailed.length === 1;
  return {
    kind: "unsupported-claim",
    claim:
      `The answer made ${single ? "a claim" : "claims"} that the cited ` +
      `${paths.length === 1 ? "source does" : "sources do"} not appear to support: ` +
      `${paths.join(", ")}. ` +
      `Treat ${single ? "that statement" : "those statements"} as unverified.` +
      citationFindingTotalSuffix(unentailed.length),
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

/** WARN marker: entailment verification could not run for part of the answer (fail-closed caveat). */
export function entailmentUnavailableMarker(nowMs: number): UncertaintyMarker {
  return {
    kind: "entailment-unavailable",
    claim:
      "Citation support could not be verified for part of this answer (the verification step was " +
      "unavailable); treat the affected claims as unconfirmed.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

interface ExcerptTextEntry {
  readonly lineRange: LineRange | undefined;
  readonly content: string;
}

function excerptMatchesCitation(entry: ExcerptTextEntry, cited: LineRange | undefined): boolean {
  if (cited === undefined) return true;
  if (entry.lineRange === undefined) return false;
  return cited.startLine <= entry.lineRange.endLine && cited.endLine >= entry.lineRange.startLine;
}

function excerptEntriesBySource(
  packs: readonly ConnectedContextPack[],
): ReadonlyMap<string, ReadonlyMap<string, readonly ExcerptTextEntry[]>> {
  const bySource = new Map<string, Map<string, ExcerptTextEntry[]>>();
  for (const [index, pack] of packs.entries()) {
    const byPath = new Map<string, ExcerptTextEntry[]>();
    for (const file of pack.files) {
      const entries = file.excerpts.map((excerpt) => ({
        lineRange: excerpt.atom.lineRange,
        content: excerpt.content,
      }));
      if (entries.length > 0) byPath.set(file.scopePath, entries);
    }
    bySource.set(citationSourceIdForIndex(index), byPath);
  }
  return bySource;
}

/**
 * Build an excerpt-text resolver from the evidence pack(s) that reached the model. For a cited
 * `[path:line]` it returns the concatenated content of the excerpts whose window overlaps the cited
 * range (or all excerpts for a bare `[path]`). The text is already redacted upstream (contracts
 * invariant); the entailment stage judges against it and never persists it.
 */
export function buildPackExcerptTextResolver(
  packs: readonly ConnectedContextPack[],
): ExcerptTextResolver {
  const citationIndex = buildPackCitationIndex(packs);
  const bySource = excerptEntriesBySource(packs);
  return (citation: ParsedInlineCitation): string | undefined => {
    const sourceId = resolveCitationSourceId(citation, citationIndex.sourceIdsByPath);
    if (sourceId === undefined) return undefined;
    const entries = bySource.get(sourceId)?.get(citation.scopePath);
    if (entries === undefined || entries.length === 0) {
      return undefined;
    }
    const matching = entries.filter((entry) => excerptMatchesCitation(entry, citation.lineRange));
    const text = matching
      .map((entry) => entry.content)
      .join("\n\n")
      .trim();
    return text.length > 0 ? text : undefined;
  };
}
