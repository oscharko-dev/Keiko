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
  "aber",
  "alle",
  "als",
  "am",
  "an",
  "auch",
  "auf",
  "aus",
  "bei",
  "bin",
  "bis",
  "bitte",
  "da",
  "das",
  "dass",
  "dein",
  "deine",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "dir",
  "du",
  "durch",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "es",
  "für",
  "habe",
  "haben",
  "hat",
  "ich",
  "im",
  "ist",
  "kann",
  "kannst",
  "kein",
  "keine",
  "mit",
  "mir",
  "nach",
  "nicht",
  "noch",
  "oder",
  "sagen",
  "sind",
  "und",
  "uns",
  "von",
  "war",
  "was",
  "welche",
  "welchen",
  "welcher",
  "welches",
  "wenn",
  "wer",
  "wie",
  "wir",
  "wird",
  "wo",
  "zu",
  "zum",
  "zur",
]);

// Module-scope regex pool. Each pattern uses character classes only (no nested quantifiers),
// so scanning is linear in input length — ReDoS-safe.
const QUOTED_DOUBLE_RE = /"([^"\n]+)"/g;
const QUOTED_SINGLE_RE = /'([^'\n]+)'/g;
const BACKTICK_RE = /`([^`\n]+)`/g;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,8}/g;
const API_ROUTE_RE = /(^|[^A-Za-z0-9_.-])((?:\/[A-Za-z0-9_.:{}-]+){2,})/g;
// Requires a genuine lower/digit -> upper transition so all-caps acronyms and SHOUTING words
// (WHY, HTTP, BROKEN) are NOT mistaken for code identifiers. A spurious 0.85 identifier anchor
// would both satisfy the clarification gate for a vague question and seed symbol-file retrieval
// with a non-symbol — see planner/plan.ts decideClarification and grounded symbolFileAnchorTerms.
const CAMEL_IDENTIFIER_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*[a-z0-9][A-Z][A-Za-z0-9_$]*)\b/g;
const TOKEN_SPLIT_RE = /[^A-Za-z0-9_.]+/;
const TECHNICAL_TERM_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly term: string;
}[] = [
  { pattern: /\btype[\s_-]?script\b/gi, term: "typescript" },
  { pattern: /\bjava[\s_-]?script\b/gi, term: "javascript" },
  { pattern: /\bnode(?:\.js)?\b/gi, term: "node" },
  { pattern: /\bnext(?:\.js)?\b/gi, term: "nextjs" },
  { pattern: /\bpackage\.json\b/gi, term: "package.json" },
  { pattern: /\bpackage[\s_-]?manager\b/gi, term: "package-manager" },
  { pattern: /\btsconfig(?:\.[a-z0-9]+)?\b/gi, term: "tsconfig" },
  { pattern: /\bvitest\b/gi, term: "vitest" },
  { pattern: /\bvite\b/gi, term: "vite" },
  { pattern: /\bplaywright\b/gi, term: "playwright" },
  { pattern: /\bjest\b/gi, term: "jest" },
  { pattern: /\bcypress\b/gi, term: "cypress" },
  { pattern: /\breact\b/gi, term: "react" },
  { pattern: /\bnpm\b/gi, term: "npm" },
  { pattern: /\bpnpm\b/gi, term: "pnpm" },
  { pattern: /\byarn\b/gi, term: "yarn" },
];

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
    const captured = match[2] ?? match[1] ?? full;
    pushAnchor(out, captured, kind, weight);
    parts.push(source.slice(cursor, match.index));
    parts.push(" ".repeat(full.length));
    cursor = match.index + full.length;
    match = re.exec(source);
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function collectTechnicalTerms(source: string, out: MutableAnchor[]): string {
  let remaining = source;
  for (const entry of TECHNICAL_TERM_PATTERNS) {
    const re = new RegExp(entry.pattern.source, entry.pattern.flags);
    const parts: string[] = [];
    let cursor = 0;
    let match = re.exec(remaining);
    while (match !== null) {
      const full = match[0];
      pushAnchor(out, entry.term, "identifier", 0.85);
      parts.push(remaining.slice(cursor, match.index));
      parts.push(" ".repeat(full.length));
      cursor = match.index + full.length;
      match = re.exec(remaining);
    }
    parts.push(remaining.slice(cursor));
    remaining = parts.join("");
  }
  return remaining;
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
  remaining = collectMatches(remaining, API_ROUTE_RE, "path", 0.95, collected);
  remaining = collectMatches(remaining, PATH_RE, "path", 0.95, collected);
  remaining = collectMatches(remaining, CAMEL_IDENTIFIER_RE, "identifier", 0.85, collected);
  remaining = collectTechnicalTerms(remaining, collected);
  const tokensConsidered = tokenizeRemaining(remaining, collected);
  const merged = sortAnchors(dedup(collected));
  const truncated = merged.length > maxAnchors;
  const final = truncated ? merged.slice(0, maxAnchors) : merged;
  return { anchors: freeze(final), truncated, tokensConsidered };
}
