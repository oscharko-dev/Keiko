// Deterministic search-anchor extraction for the exploration planner (Epic #177, Issue #181).
// Pure JS — no IO, no clock, no randomness. Given free-form prompt text, this module produces
// a small, stable, weight-ordered set of search anchors. The stop-word list is intentionally
// fixed and English-only; expanding language coverage is a follow-up issue.

const MAX_INPUT_LENGTH = 4096;

const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "what",
  "where",
  "when",
  "which",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "is",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "doing",
  "of",
  "in",
  "on",
  "at",
  "to",
  "an",
  "as",
  "or",
  "but",
  "not",
  "no",
  "yes",
  "if",
  "by",
  "it",
  "its",
  "you",
  "your",
  "we",
  "our",
  "they",
  "their",
  "them",
  "he",
  "she",
  "his",
  "her",
  "my",
  "me",
  "i",
  "us",
  "how",
  "why",
  "who",
  "whom",
  "whose",
  "than",
  "then",
  "there",
  "can",
  "could",
  "would",
  "should",
  "may",
  "might",
  "must",
  "will",
  "so",
  "such",
  "any",
  "all",
  "some",
  "every",
  "each",
]);

// Module-scope regex pool. Each pattern uses character classes only (no nested quantifiers),
// so scanning is linear in input length — ReDoS-safe.
const QUOTED_DOUBLE_RE = /"([^"\n]+)"/g;
const QUOTED_SINGLE_RE = /'([^'\n]+)'/g;
const BACKTICK_RE = /`([^`\n]+)`/g;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,8}/g;
const TOKEN_SPLIT_RE = /[^A-Za-z0-9_.]+/;

export type SearchAnchorKind = "literal" | "identifier" | "path" | "quoted";

export interface SearchAnchor {
  readonly term: string;
  readonly weight: number;
  readonly kind: SearchAnchorKind;
}

export interface AnchorExtractionInput {
  readonly text: string;
  readonly maxAnchors: number;
}

export interface AnchorExtractionResult {
  readonly anchors: readonly SearchAnchor[];
  readonly truncated: boolean;
  readonly tokensConsidered: number;
}

interface MutableAnchor {
  term: string;
  weight: number;
  kind: SearchAnchorKind;
}

function pushAnchor(
  out: MutableAnchor[],
  raw: string,
  kind: SearchAnchorKind,
  weight: number,
): void {
  const term = raw.trim().toLowerCase();
  if (term.length > 0) {
    out.push({ term, weight, kind });
  }
}

function collectMatches(
  source: string,
  pattern: RegExp,
  kind: SearchAnchorKind,
  weight: number,
  out: MutableAnchor[],
): string {
  const re = new RegExp(pattern.source, pattern.flags);
  const parts: string[] = [];
  let cursor = 0;
  let match = re.exec(source);
  while (match !== null) {
    const full = match[0];
    const captured = match[1] ?? full;
    pushAnchor(out, captured, kind, weight);
    parts.push(source.slice(cursor, match.index));
    parts.push(" ".repeat(full.length));
    cursor = match.index + full.length;
    match = re.exec(source);
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function tokenizeRemaining(remaining: string, out: MutableAnchor[]): number {
  let considered = 0;
  for (const raw of remaining.split(TOKEN_SPLIT_RE)) {
    if (raw.length === 0) {
      continue;
    }
    considered += 1;
    const token = raw.toLowerCase();
    if (token.length < 3) {
      continue;
    }
    if (STOP_WORDS.has(token)) {
      continue;
    }
    if (token.includes(".")) {
      out.push({ term: token, weight: 0.8, kind: "identifier" });
      continue;
    }
    out.push({ term: token, weight: 0.5, kind: "literal" });
  }
  return considered;
}

function dedup(anchors: readonly MutableAnchor[]): MutableAnchor[] {
  const best = new Map<string, MutableAnchor>();
  for (const anchor of anchors) {
    const existing = best.get(anchor.term);
    if (existing === undefined || anchor.weight > existing.weight) {
      best.set(anchor.term, { ...anchor });
    }
  }
  return Array.from(best.values());
}

function sortAnchors(anchors: MutableAnchor[]): MutableAnchor[] {
  return anchors.sort((a, b) => {
    if (a.weight !== b.weight) {
      return b.weight - a.weight;
    }
    return a.term.localeCompare(b.term);
  });
}

function freeze(anchors: readonly MutableAnchor[]): readonly SearchAnchor[] {
  return anchors.map((a) => ({ term: a.term, weight: a.weight, kind: a.kind }));
}

export function extractAnchors(input: AnchorExtractionInput): AnchorExtractionResult {
  const { text, maxAnchors } = input;
  if (text.length === 0) {
    return { anchors: [], truncated: false, tokensConsidered: 0 };
  }
  if (text.length > MAX_INPUT_LENGTH) {
    return { anchors: [], truncated: true, tokensConsidered: 0 };
  }
  const collected: MutableAnchor[] = [];
  let remaining = collectMatches(text, QUOTED_DOUBLE_RE, "quoted", 1, collected);
  remaining = collectMatches(remaining, QUOTED_SINGLE_RE, "quoted", 1, collected);
  remaining = collectMatches(remaining, BACKTICK_RE, "identifier", 0.9, collected);
  remaining = collectMatches(remaining, PATH_RE, "path", 0.95, collected);
  const tokensConsidered = tokenizeRemaining(remaining, collected);
  const merged = sortAnchors(dedup(collected));
  const truncated = merged.length > maxAnchors;
  const final = truncated ? merged.slice(0, maxAnchors) : merged;
  return { anchors: freeze(final), truncated, tokensConsidered };
}
