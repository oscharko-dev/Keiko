// Pure match strategies and the query fingerprint used by the repo-search facade (Issue #179).
// Kept separate from repoSearch.ts to hold the file-length cap and to make every matcher
// independently testable.

import { createHash } from "node:crypto";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { RepoSearchInvalidQueryError } from "./errors.js";

export interface LineMatcher {
  readonly match: (line: string) => number;
}

export function fingerprintFor(query: RetrievalQuery): string {
  const canonical = JSON.stringify({
    kind: query.kind,
    text: query.text,
    caseSensitive: query.caseSensitive,
    maxResults: query.maxResults,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// Issue #177 retrieval correctness: a natural-language question carries function words ("the",
// "to", "are", "based", "on", ...) that appear on nearly every prose line. Scoring the raw
// whitespace tokens let those stop words match almost everything, so the global
// `maxMatchesReturned` budget was exhausted on the first alphabetically-scanned files and the
// rest of a multi-file scope was never read (a `docs/` connect would only ever surface its
// first file, never the file the question was actually about). We mirror the exploration
// planner's fixed English stop-word policy (planner/anchors.ts in keiko-workflows — duplicated
// here rather than imported because the architecture forbids keiko-workspace depending on the
// higher-level keiko-workflows package): strip surrounding punctuation, drop single-character and
// stop-word tokens, and keep `adr-0022`/`file.ts`-style hyphenated and dotted identifiers intact.
const NL_STOP_WORDS: ReadonlySet<string> = new Set([
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
  "about",
  "into",
  "only",
  "based",
  "answer",
]);

// Strip leading/trailing non-alphanumeric characters (Unicode-aware) while preserving internal
// punctuation such as the hyphen in "ADR-0022" or the dot in "file.ts". Anchored, single
// character-class quantifiers only — linear in input length (ReDoS-safe).
function normalizeNaturalLanguageToken(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

// Extract the content tokens a relevance score should be computed over. Falls back to the
// normalized-but-unfiltered tokens when filtering removes everything (a degenerate single-char
// or stop-word-only query), so the matcher never silently scores nothing.
function naturalLanguageContentTokens(
  rawTokens: readonly string[],
  caseSensitive: boolean,
): readonly string[] {
  const normalized = rawTokens
    .map(normalizeNaturalLanguageToken)
    .filter((t) => t.length > 0)
    .map((t) => (caseSensitive ? t : t.toLowerCase()));
  const content = normalized.filter((t) => t.length >= 2 && !NL_STOP_WORDS.has(t.toLowerCase()));
  return content.length > 0 ? content : normalized;
}

function buildNaturalLanguageMatcher(query: RetrievalQuery): LineMatcher {
  const rawTokens = query.text.split(/\s+/).filter((t) => t.length > 0);
  const tokens = naturalLanguageContentTokens(rawTokens, query.caseSensitive);
  const total = tokens.length;
  return {
    match: (line: string): number => {
      if (total === 0) {
        return 0;
      }
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      let hits = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          hits += 1;
        }
      }
      return hits === 0 ? 0 : hits / total;
    },
  };
}

function buildExactSymbolMatcher(query: RetrievalQuery): LineMatcher {
  if (/\s/.test(query.text)) {
    throw new RepoSearchInvalidQueryError("exact-symbol query must not contain whitespace");
  }
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  return {
    match: (line: string): number => {
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      return haystack.includes(needle) ? 1 : 0;
    },
  };
}

// Cap regex source length and refuse the classical catastrophic-backtracking shapes — any
// group `(...)` or character class `[...]` followed by a `+` / `*` / `{n,}` quantifier. The
// per-call elapsedMsMax cannot interrupt a synchronous `RegExp.exec` once it has entered a
// pathological backtrack, so the only safe defense is to refuse the pattern at compile time.
const MAX_REGEX_LENGTH = 200;
const DANGEROUS_REGEX_STRUCTURE = /\([^)]*\)[+*{]|\[[^\]]*\][+*{]/;

function buildRegexMatcher(query: RetrievalQuery): LineMatcher {
  if (query.text.length > MAX_REGEX_LENGTH) {
    throw new RepoSearchInvalidQueryError(
      `regex too long: ${String(query.text.length)} > ${String(MAX_REGEX_LENGTH)}`,
    );
  }
  if (DANGEROUS_REGEX_STRUCTURE.test(query.text)) {
    throw new RepoSearchInvalidQueryError(
      "regex contains repetition over a group or character class (potential catastrophic backtracking)",
    );
  }
  let regex: RegExp;
  try {
    regex = new RegExp(query.text, query.caseSensitive ? "g" : "gi");
  } catch {
    throw new RepoSearchInvalidQueryError(`invalid regex: ${query.text}`);
  }
  const cap = 100;
  return {
    match: (line: string): number => {
      regex.lastIndex = 0;
      let count = 0;
      while (regex.exec(line) !== null && count < cap) {
        count += 1;
        if (regex.lastIndex === 0) {
          break;
        }
      }
      return count === 0 ? 0 : count / cap;
    },
  };
}

export function buildMatcher(query: RetrievalQuery): LineMatcher {
  if (query.kind === "natural-language") {
    return buildNaturalLanguageMatcher(query);
  }
  if (query.kind === "exact-symbol") {
    return buildExactSymbolMatcher(query);
  }
  if (query.kind === "regex") {
    return buildRegexMatcher(query);
  }
  throw new RepoSearchInvalidQueryError(`unsupported query kind: ${query.kind}`);
}

// Anchored-glob compilation for findFiles. Supports `*`, `**`, `?`, and literal characters.
// Brace expansion and extglob patterns are intentionally not supported.
export function compileGlob(pattern: string): RegExp {
  let body = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*" && pattern.charAt(i + 1) === "*") {
      body += ".*";
      i += pattern.charAt(i + 2) === "/" ? 3 : 2;
      continue;
    }
    if (ch === "*") {
      body += "[^/]*";
    } else if (ch === "?") {
      body += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
    i += 1;
  }
  return new RegExp(`^${body}$`);
}
