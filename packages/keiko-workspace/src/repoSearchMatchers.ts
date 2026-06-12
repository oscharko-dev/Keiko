// Pure match strategies and the query fingerprint used by the repo-search facade (Issue #179).
// Kept separate from repoSearch.ts to hold the file-length cap and to make every matcher
// independently testable.

import { createHash } from "node:crypto";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { regexSafetyIssue } from "./repoSearchRegexSafety.js";

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
// planner's fixed English stop-word policy (planner/anchors.ts in keiko-workflows - duplicated
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

const DEFINITION_INTENT_TOKENS: ReadonlySet<string> = new Set([
  "define",
  "defined",
  "definition",
  "declare",
  "declared",
  "declaration",
  "implement",
  "implements",
  "implemented",
  "implementation",
]);

const HTTP_METHOD_TOKENS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

interface NaturalLanguageIntent {
  readonly definitionIntent: boolean;
  readonly symbolTokens: readonly string[];
  readonly routeTokens: readonly string[];
  readonly httpMethods: readonly string[];
}

// Strip leading/trailing non-alphanumeric characters (Unicode-aware) while preserving internal
// punctuation such as the hyphen in "ADR-0022" or the dot in "file.ts". Anchored, single
// character-class quantifiers only - linear in input length (ReDoS-safe).
function normalizeNaturalLanguageToken(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

function naturalLanguageNormalizedTokens(rawTokens: readonly string[]): readonly string[] {
  return rawTokens.map(normalizeNaturalLanguageToken).filter((t) => t.length > 0);
}

// Extract the content tokens a relevance score should be computed over. Falls back to the
// normalized-but-unfiltered tokens when filtering removes everything (a degenerate single-char
// or stop-word-only query), so the matcher never silently scores nothing.
function naturalLanguageContentTokens(
  rawTokens: readonly string[],
  caseSensitive: boolean,
): readonly string[] {
  const normalized = naturalLanguageNormalizedTokens(rawTokens).map((t) =>
    caseSensitive ? t : t.toLowerCase(),
  );
  const content = normalized.filter((t) => t.length >= 2 && !NL_STOP_WORDS.has(t.toLowerCase()));
  return content.length > 0 ? content : normalized;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isDefinitionIntentToken(token: string): boolean {
  return DEFINITION_INTENT_TOKENS.has(token.toLowerCase());
}

function isSymbolLikeToken(token: string): boolean {
  return /[A-Z_]/u.test(token) || token.includes("-");
}

function analyzeNaturalLanguageIntent(
  normalizedTokens: readonly string[],
  caseSensitive: boolean,
): NaturalLanguageIntent {
  const lowered = normalizedTokens.map((t) => t.toLowerCase());
  const definitionIntent = lowered.some(isDefinitionIntentToken);
  const symbolTokens = uniqueStrings(
    normalizedTokens
      .filter((t) => isSymbolLikeToken(t) && !DEFINITION_INTENT_TOKENS.has(t.toLowerCase()))
      .map((t) => (caseSensitive ? t : t.toLowerCase())),
  );
  const routeTokens = uniqueStrings(
    normalizedTokens
      .filter((t) => t.includes("/"))
      .map((t) => (caseSensitive ? t : t.toLowerCase())),
  );
  const httpMethods = uniqueStrings(
    lowered.filter((t) => HTTP_METHOD_TOKENS.has(t)).map((t) => (caseSensitive ? t : t.toLowerCase())),
  );
  return { definitionIntent, symbolTokens, routeTokens, httpMethods };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lineLooksLikeImport(line: string): boolean {
  return /^\s*import\b/u.test(line) || /^\s*export\s*\{/u.test(line);
}

function lineLooksLikeSymbolDefinition(
  line: string,
  symbolToken: string,
  caseSensitive: boolean,
): boolean {
  const escaped = escapeRegExp(symbolToken);
  const flags = caseSensitive ? "u" : "iu";
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, flags),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`, flags),
    new RegExp(`\\b(?:export\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`, flags),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`, flags),
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function lineLooksLikeRouteDeclaration(
  line: string,
  haystack: string,
  intent: NaturalLanguageIntent,
): boolean {
  const routeHit = intent.routeTokens.some((token) => haystack.includes(token));
  const methodHit = intent.httpMethods.some((method) => haystack.includes(`"${method}"`));
  if (!routeHit || !methodHit) {
    return false;
  }
  return line.includes("method:") || line.includes("pattern:");
}

function adjustedDefinitionIntentScore(
  line: string,
  haystack: string,
  baseScore: number,
  intent: NaturalLanguageIntent,
  caseSensitive: boolean,
): number {
  if (!intent.definitionIntent) {
    return baseScore;
  }
  let bonus = 0;
  let penalty = 0;
  for (const symbolToken of intent.symbolTokens) {
    if (!haystack.includes(symbolToken)) {
      continue;
    }
    if (lineLooksLikeSymbolDefinition(line, symbolToken, caseSensitive)) {
      bonus = Math.max(bonus, 0.75);
    } else if (lineLooksLikeImport(line)) {
      penalty = Math.max(penalty, 0.2);
    }
  }
  if (lineLooksLikeRouteDeclaration(line, haystack, intent)) {
    bonus = Math.max(bonus, 0.65);
  }
  return Math.max(0, Math.min(1, baseScore + bonus - penalty));
}

function buildNaturalLanguageMatcher(query: RetrievalQuery): LineMatcher {
  const rawTokens = query.text.split(/\s+/).filter((t) => t.length > 0);
  const normalizedTokens = naturalLanguageNormalizedTokens(rawTokens);
  const tokens = naturalLanguageContentTokens(rawTokens, query.caseSensitive);
  const intent = analyzeNaturalLanguageIntent(normalizedTokens, query.caseSensitive);
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
      if (hits === 0) {
        return 0;
      }
      return adjustedDefinitionIntentScore(
        line,
        haystack,
        hits / total,
        intent,
        query.caseSensitive,
      );
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

function buildRegexMatcher(query: RetrievalQuery): LineMatcher {
  const issue = regexSafetyIssue(query.text);
  if (issue !== undefined) {
    throw new RepoSearchInvalidQueryError(issue);
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
