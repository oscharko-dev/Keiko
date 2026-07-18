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
}

/** Per-answer bounds so the judge is never invoked unboundedly. */
export interface EntailmentOptions {
  readonly maxClaims: number;
  readonly maxExcerptChars: number;
}

export const DEFAULT_ENTAILMENT_OPTIONS: EntailmentOptions = {
  maxClaims: 24,
  maxExcerptChars: 900,
};

function isSentenceBoundary(ch: string): boolean {
  return ch === "." || ch === "!" || ch === "?" || ch === "\n";
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
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]" && depth > 0) {
      depth -= 1;
    } else if (depth === 0 && isSentenceBoundary(ch)) {
      if (text.slice(start, i + 1).trim().length > 0) {
        spans.push(text.slice(start, i + 1));
      }
      start = i + 1;
    }
  }
  if (text.slice(start).trim().length > 0) {
    spans.push(text.slice(start));
  }
  return spans;
}

/** Remove inline `[...]` citation brackets from a claim span so the judge sees the prose claim. */
export function stripInlineCitations(text: string): string {
  return text
    .replace(/\[[^\]\n]{1,200}\]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Segment an answer into the cited claims (spans that carry at least one inline citation). */
export function segmentCitedClaims(answerText: string): readonly CitedClaim[] {
  const claims: CitedClaim[] = [];
  for (const span of splitClaimSpans(answerText)) {
    const citations = parseInlineCitations(span);
    if (citations.length > 0) {
      claims.push({ claimText: stripInlineCitations(span), citations });
    }
  }
  return claims;
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
}

/** Resolve the bounded excerpt text for a membership-valid citation, or `undefined` if none. */
export type ExcerptTextResolver = (citation: ParsedInlineCitation) => string | undefined;

function collectExcerptText(
  citations: readonly ParsedInlineCitation[],
  resolveExcerptText: ExcerptTextResolver,
  maxExcerptChars: number,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const citation of citations) {
    const text = resolveExcerptText(citation)?.trim();
    if (text === undefined || text.length === 0 || seen.has(text)) {
      continue;
    }
    seen.add(text);
    parts.push(text);
  }
  return parts.join("\n\n").slice(0, maxExcerptChars);
}

async function verdictForClaim(
  claim: CitedClaim,
  validCitations: readonly ParsedInlineCitation[],
  resolveExcerptText: ExcerptTextResolver,
  judge: EntailmentJudge,
  maxExcerptChars: number,
  signal: AbortSignal | undefined,
): Promise<EntailmentVerdict> {
  const excerptText = collectExcerptText(validCitations, resolveExcerptText, maxExcerptChars);
  if (excerptText.length === 0 || claim.claimText.length === 0) {
    // No usable excerpt/claim text to judge against — undecidable, never assumed supported.
    return "unavailable";
  }
  return judge.judge({ claimText: claim.claimText, excerptText }, signal);
}

/**
 * Judge, per cited claim, whether its MEMBERSHIP-VALID citations' excerpts support the claim.
 * Only citations absent from `membership.unsupported` are judged (so membership failures are never
 * re-reported as entailment failures). Bounded by `options`. The judge port decides each verdict;
 * `unavailable` verdicts are counted, never treated as supported.
 */
export async function reconcileClaimEntailment(
  answerText: string,
  membership: CitationReconciliation,
  resolveExcerptText: ExcerptTextResolver,
  judge: EntailmentJudge,
  options: EntailmentOptions = DEFAULT_ENTAILMENT_OPTIONS,
  signal?: AbortSignal,
): Promise<EntailmentReconciliation> {
  const membershipFailed = new Set(membership.unsupported.map(citationDedupKey));
  const unentailed: UnentailedClaim[] = [];
  let judgedClaims = 0;
  let unavailableClaims = 0;
  for (const claim of segmentCitedClaims(answerText)) {
    if (judgedClaims >= options.maxClaims) {
      break;
    }
    const valid = claim.citations.filter((c) => !membershipFailed.has(citationDedupKey(c)));
    if (valid.length === 0) {
      continue;
    }
    const verdict = await verdictForClaim(
      claim,
      valid,
      resolveExcerptText,
      judge,
      options.maxExcerptChars,
      signal,
    );
    judgedClaims += 1;
    if (verdict === "unsupported") {
      unentailed.push({ citedPaths: [...new Set(valid.map((c) => c.scopePath))] });
    } else if (verdict === "unavailable") {
      unavailableClaims += 1;
    }
  }
  return { unentailed, judgedClaims, unavailableClaims };
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
  const paths = [...new Set(unentailed.flatMap((c) => c.citedPaths))].slice(0, 8);
  const single = unentailed.length === 1;
  return {
    kind: "unsupported-claim",
    claim:
      `The answer made ${single ? "a claim" : "claims"} that the cited ` +
      `${paths.length === 1 ? "source does" : "sources do"} not appear to support: ` +
      `${paths.join(", ")}. Treat ${single ? "that statement" : "those statements"} as unverified.`,
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
  if (cited === undefined || entry.lineRange === undefined) {
    // A bare citation (or a window-less excerpt) matches at the path level.
    return true;
  }
  return cited.startLine <= entry.lineRange.endLine && cited.endLine >= entry.lineRange.startLine;
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
  const byPath = new Map<string, ExcerptTextEntry[]>();
  for (const pack of packs) {
    for (const file of pack.files) {
      for (const excerpt of file.excerpts) {
        const entries = byPath.get(file.scopePath) ?? [];
        entries.push({ lineRange: excerpt.atom.lineRange, content: excerpt.content });
        byPath.set(file.scopePath, entries);
      }
    }
  }
  return (citation: ParsedInlineCitation): string | undefined => {
    const entries = byPath.get(citation.scopePath);
    if (entries === undefined || entries.length === 0) {
      return undefined;
    }
    const matching = entries.filter((entry) => excerptMatchesCitation(entry, citation.lineRange));
    const chosen = matching.length > 0 ? matching : entries;
    const text = chosen
      .map((entry) => entry.content)
      .join("\n\n")
      .trim();
    return text.length > 0 ? text : undefined;
  };
}
