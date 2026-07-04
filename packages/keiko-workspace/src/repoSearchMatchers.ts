// Pure match strategies and the query fingerprint used by the repo-search facade (Issue #179).
// Kept separate from repoSearch.ts to hold the file-length cap and to make every matcher
// independently testable.

import { createHash } from "node:crypto";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  ecosystemTechnicalPhrases,
  ecosystemVersionDeclarationPatterns,
  type EcosystemVersionDeclarationPattern,
} from "./ecosystems.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { expandedQueryTermGroups, expandedQueryTerms } from "./repoSearchQueryTerms.js";
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

const TECHNICAL_PHRASES: readonly { readonly pattern: RegExp; readonly term: string }[] = [
  { pattern: /\btype[\s_-]?script\b/iu, term: "typescript" },
  { pattern: /\bjava[\s_-]?script\b/iu, term: "javascript" },
  { pattern: /\bnode(?:\.js)?\b/iu, term: "node" },
  { pattern: /\bnext(?:\.js)?\b/iu, term: "nextjs" },
  { pattern: /\bpackage\.json\b/iu, term: "package.json" },
  { pattern: /\bpackage[\s_-]?manager\b|\bpaket[\s_-]?manager\b/iu, term: "package-manager" },
  { pattern: /\btest[\s_-]?runner\b|\btestumgebung\b/iu, term: "test-runner" },
  // Ecosystem-aware content tokens (e.g. a Java/Maven question also searches for "maven.compiler"
  // so the exact version-declaration line in pom.xml wins the line-range evidence). Sourced from
  // the shared registry; only ecosystems with routing terms contribute (JS/TS handled above).
  ...ecosystemTechnicalPhrases,
];

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

function naturalLanguageContentGroups(
  rawGroups: readonly (readonly string[])[],
  caseSensitive: boolean,
): readonly (readonly string[])[] {
  const contentGroups = rawGroups
    .map((group) =>
      naturalLanguageNormalizedTokens(group)
        .map((t) => (caseSensitive ? t : t.toLowerCase()))
        .filter((t) => t.length >= 2 && !NL_STOP_WORDS.has(t.toLowerCase())),
    )
    .filter((group) => group.length > 0);
  if (contentGroups.length > 0) {
    return contentGroups;
  }
  return rawGroups
    .map((group) =>
      naturalLanguageNormalizedTokens(group).map((t) => (caseSensitive ? t : t.toLowerCase())),
    )
    .filter((group) => group.length > 0);
}

function technicalPhraseTerms(queryText: string, caseSensitive: boolean): readonly string[] {
  const terms = new Set<string>();
  for (const entry of TECHNICAL_PHRASES) {
    if (entry.pattern.test(queryText)) {
      terms.add(caseSensitive ? entry.term : entry.term.toLowerCase());
    }
  }
  return [...terms];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function naturalLanguageContentTerms(
  queryText: string,
  caseSensitive: boolean,
): readonly string[] {
  const rawTokens = expandedQueryTerms(queryText, caseSensitive);
  return uniqueStrings([
    ...naturalLanguageContentGroups([rawTokens], caseSensitive).flat(),
    ...technicalPhraseTerms(queryText, caseSensitive),
  ]);
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
    lowered
      .filter((t) => HTTP_METHOD_TOKENS.has(t))
      .map((t) => (caseSensitive ? t : t.toLowerCase())),
  );
  return { definitionIntent, symbolTokens, routeTokens, httpMethods };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lineLooksLikeImport(line: string): boolean {
  return /^\s*import\b/u.test(line) || /^\s*export\s*\{/u.test(line);
}

function lineLooksLikeDeclaration(line: string): boolean {
  return /^\s*(?:export\s+)?(?:(?:async|default|declare|public|private|protected|readonly|static)\s+)*(?:const|let|var|function|class|interface|type|enum)\b/u.test(
    line,
  );
}

function lineLooksLikeSymbolDefinition(
  line: string,
  symbolToken: string,
  caseSensitive: boolean,
): boolean {
  const escaped = escapeRegExp(symbolToken);
  const flags = caseSensitive ? "u" : "iu";
  const modifiers =
    "(?:(?:export|public|private|protected|internal|static|abstract|final|sealed|partial|data|open|override|virtual|readonly|async)\\s+)*";
  const patterns = [
    new RegExp(`\\b${modifiers}function\\s+${escaped}\\b`, flags),
    new RegExp(`\\b${modifiers}(?:const|let|var)\\s+${escaped}\\b`, flags),
    new RegExp(
      `\\b${modifiers}(?:class|interface|type|enum|record|struct|trait|object)\\s+${escaped}\\b`,
      flags,
    ),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`, flags),
    new RegExp(`\\b${modifiers}(?:def|func|fn|fun)\\s+${escaped}\\s*\\(`, flags),
    new RegExp(`\\btype\\s+${escaped}\\s+(?:struct|interface)\\b`, flags),
    new RegExp(`\\b${modifiers}[A-Za-z_$][\\w$<>, ?.[\\]]+\\s+${escaped}\\s*\\(`, flags),
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function routeMethodMatches(haystack: string, method: string): boolean {
  return [
    `"${method}"`,
    `'${method}'`,
    `.${method}(`,
    ` ${method}(`,
    `@${method}mapping`,
    `methods("${method}"`,
    `methods('${method}'`,
  ].some((needle) => haystack.includes(needle));
}

function routeDeclarationShapeMatches(haystack: string): boolean {
  return (
    haystack.includes("method:") ||
    haystack.includes("pattern:") ||
    haystack.includes("path:") ||
    haystack.includes("router.") ||
    haystack.includes("app.") ||
    haystack.includes("server.") ||
    haystack.includes("@") ||
    haystack.includes("handlefunc") ||
    haystack.includes("route(")
  );
}

function lineLooksLikeRouteDeclaration(haystack: string, intent: NaturalLanguageIntent): boolean {
  const routeHit = intent.routeTokens.some((token) => haystack.includes(token));
  const methodHit = intent.httpMethods.some((method) => routeMethodMatches(haystack, method));
  return routeHit && methodHit && routeDeclarationShapeMatches(haystack);
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
    } else if (lineLooksLikeDeclaration(line)) {
      bonus = Math.max(bonus, 0.55);
    } else if (lineLooksLikeImport(line)) {
      penalty = Math.max(penalty, 0.2);
    }
  }
  if (lineLooksLikeRouteDeclaration(haystack, intent)) {
    bonus = Math.max(bonus, 0.65);
  }
  return Math.max(0, Math.min(1, baseScore + bonus - penalty));
}

// A version-ish value on the line: a digit (manifest version declarations always carry one, e.g.
// `<maven.compiler.release>21`, `requires-python = ">=3.11"`, `go 1.23.0`). Single linear class —
// ReDoS-safe. The gate that makes this precise is the ecosystem content-token check below, not this.
const HAS_VERSIONISH_VALUE = /\d/u;

// M3: when the query routed to an ecosystem, reward the line that actually DECLARES the version (it
// contains an ecosystem content token such as "maven.compiler" / "requires-python" AND a numeric
// value) so it outscores prose/other lines and its excerpt window is surfaced first. Mirrors the
// adjustedDefinitionIntentScore bonus pattern; deterministic and ReDoS-safe.
function adjustedVersionDeclarationScore(
  line: string,
  baseScore: number,
  versionDeclarationPatterns: readonly EcosystemVersionDeclarationPattern[],
): number {
  if (versionDeclarationPatterns.length === 0) {
    return baseScore;
  }
  const lower = line.toLowerCase();
  for (const entry of versionDeclarationPatterns) {
    if (
      entry.declarationPattern.test(line) &&
      (!entry.requiresNumeric || HAS_VERSIONISH_VALUE.test(lower))
    ) {
      return Math.max(0, Math.min(1, baseScore + 0.75));
    }
  }
  return baseScore;
}

function buildNaturalLanguageMatcher(query: RetrievalQuery): LineMatcher {
  const rawGroups = expandedQueryTermGroups(query.text, query.caseSensitive);
  const intentTokens = expandedQueryTerms(query.text, true);
  const normalizedTokens = naturalLanguageNormalizedTokens(intentTokens);
  // GRD-033: dedupe alternatives inside each original-token group so aliases/stems improve recall
  // without making every alias an additional required term in `hits/total`.
  const tokenGroups = [
    ...naturalLanguageContentGroups(rawGroups, query.caseSensitive).map(uniqueStrings),
    ...technicalPhraseTerms(query.text, query.caseSensitive).map((term) => [term] as const),
  ];
  const intent = analyzeNaturalLanguageIntent(normalizedTokens, query.caseSensitive);
  // The ecosystem declaration-line patterns whose routing pattern matched this query (e.g. for a
  // Java question: maven.compiler/java.version; for a Go question: go/toolchain directives).
  const versionDeclarationPatterns = ecosystemVersionDeclarationPatterns.filter((p) =>
    p.routePattern.test(query.text),
  );
  const total = tokenGroups.length;
  return {
    match: (line: string): number => {
      if (total === 0) {
        return 0;
      }
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      let hits = 0;
      for (const group of tokenGroups) {
        if (group.some((token) => haystack.includes(token))) {
          hits += 1;
        }
      }
      if (hits === 0) {
        return 0;
      }
      const definitionAdjusted = adjustedDefinitionIntentScore(
        line,
        haystack,
        hits / total,
        intent,
        query.caseSensitive,
      );
      return adjustedVersionDeclarationScore(line, definitionAdjusted, versionDeclarationPatterns);
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
export function compileGlob(pattern: string, caseSensitive = true): RegExp {
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
  return new RegExp(`^${body}$`, caseSensitive ? "u" : "iu");
}
