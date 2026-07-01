// Citation attachment (Epic #189, Issue #200). Extracts inline `[n]` markers from the
// answer text and maps each marker to its `RetrievalReference` by 1-based index. The
// Conversation Center UI surfaces the returned `citations` array as clickable footnotes;
// `text` is the (unchanged) answer string the BFF persists to the chat row.
//
// Tolerance rules (the markers are LLM output — never assume well-formed):
//   * `[0]` and `[n]` for n > references.length are silently dropped. We do NOT mutate
//     the answer text — keeping the original prose means the UI can still display the
//     stray marker; the citations array just won't link it.
//   * Duplicate markers (`[1]` appearing twice) produce two entries in the citations
//     array, in document order. The UI is responsible for de-duplicating if it wants a
//     "unique footnotes" view.
//   * Markers with leading zeros (`[01]`) are accepted to match what some models emit;
//     the parsed integer is what's matched against the reference list.
//   * Bracket glyphs beyond ASCII `[ ]` are accepted: CJK lenticular `【n】` and fullwidth
//     `［n］`. Some models (e.g. gpt-oss) emit these instead of ASCII brackets; without
//     this tolerance their citations would be lost and the caller would fall back to
//     attaching every reference. The original glyph is preserved in `marker`.
//   * No regex backtracking traps — the pattern is `[bracket](\d+)[bracket]`, linear in the
//     answer length, bounded by digit count (each class matches exactly one character).

import type { CitationReference, RetrievalReference } from "@oscharko-dev/keiko-contracts";

import type { ConversationCitationReference } from "./types.js";

export interface AttachCitationsResult {
  readonly text: string;
  readonly citations: readonly ConversationCitationReference[];
}

export interface CitationFaithfulnessOptions {
  readonly excerptForReference?: (reference: RetrievalReference, index: number) => string;
  readonly minOverlapTokens?: number;
}

// Linear scan; the pattern has no alternation or unbounded lookbehind so backtracking is
// O(n) in the answer length. ECMAScript's `RegExp` with the `g` flag is the simplest
// portable implementation; we cannot share a single static instance across calls because
// `lastIndex` is mutated during iteration (a single shared instance would corrupt under
// concurrent generator runs).
// Open ∈ { [ , 【 (U+3010), ［ (U+FF3B) }; close ∈ { ] , 】 (U+3011), ］ (U+FF3D) }. Each
// class matches exactly one character so the linear-scan / no-backtracking property holds.
// Mismatched pairs (`[1】`) are accepted intentionally — markers are untrusted LLM output.
const MARKER_PATTERN = /[[【［](\d+)[\]】］]/g;

// eslint-disable-next-line complexity
export function attachCitationsToAnswer(
  answer: string,
  references: readonly RetrievalReference[],
  options: CitationFaithfulnessOptions = {},
): AttachCitationsResult {
  if (answer.length === 0 || references.length === 0) {
    return { text: answer, citations: [] };
  }
  const citations: ConversationCitationReference[] = [];
  const re = new RegExp(MARKER_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(answer)) !== null) {
    const marker = match[0];
    const raw = match[1];
    if (raw === undefined) continue;
    const index = Number.parseInt(raw, 10);
    if (!Number.isFinite(index) || index < 1 || index > references.length) continue;
    const reference = references[index - 1];
    if (reference === undefined) continue;
    if (!citationPassesFaithfulness(answer, match.index, reference, index, options)) continue;
    citations.push(buildCitationEntry(marker, index, reference));
  }
  return { text: answer, citations };
}

const CLAIM_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "das",
  "der",
  "die",
  "ein",
  "eine",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "mit",
  "of",
  "on",
  "or",
  "the",
  "to",
  "und",
  "von",
  "was",
  "with",
  "zu",
]);

const SIGNIFICANT_TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_./:-]{2,}/gu;
const SENTENCE_BOUNDARY_PATTERN = /[.!?\n]/u;

function citationPassesFaithfulness(
  answer: string,
  markerOffset: number,
  reference: RetrievalReference,
  index: number,
  options: CitationFaithfulnessOptions,
): boolean {
  if (options.excerptForReference === undefined) return true;
  const sentence = citationSentence(answer, markerOffset);
  const claimTokens = significantTokens(stripMarkers(sentence));
  if (claimTokens.length === 0) return false;
  const excerptTokens = new Set(significantTokens(options.excerptForReference(reference, index)));
  if (excerptTokens.size === 0) return false;
  const overlap = [...new Set(claimTokens)].filter((token) => excerptTokens.has(token)).length;
  const required = Math.max(
    options.minOverlapTokens ?? 2,
    Math.min(4, Math.ceil(claimTokens.length * 0.35)),
  );
  return overlap >= Math.min(required, claimTokens.length);
}

function citationSentence(answer: string, markerOffset: number): string {
  let start = markerOffset;
  while (start > 0 && !SENTENCE_BOUNDARY_PATTERN.test(answer[start - 1] ?? "")) {
    start -= 1;
  }
  let end = markerOffset;
  while (end < answer.length && !SENTENCE_BOUNDARY_PATTERN.test(answer[end] ?? "")) {
    end += 1;
  }
  return answer.slice(start, end);
}

function stripMarkers(value: string): string {
  return value.replace(new RegExp(MARKER_PATTERN.source, "g"), " ");
}

function significantTokens(value: string): readonly string[] {
  const out: string[] = [];
  for (const match of value.normalize("NFC").toLocaleLowerCase("und").matchAll(
    SIGNIFICANT_TOKEN_PATTERN,
  )) {
    const token = match[0];
    if (CLAIM_STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

function buildCitationEntry(
  marker: string,
  index: number,
  reference: RetrievalReference,
): ConversationCitationReference {
  const citation: CitationReference = reference.citation;
  return { marker, index, citation, reference };
}
