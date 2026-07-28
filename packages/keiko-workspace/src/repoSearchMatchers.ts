// Pure match strategies and the query fingerprint used by the repo-search facade (Issue #179).
// Kept separate from repoSearch.ts to hold the file-length cap and to make every matcher
// independently testable.

import { createHash } from "node:crypto";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memoizeByStringKey } from "./boundedMemo.js";
import {
  ecosystemTechnicalPhrases,
  ecosystemVersionDeclarationPatterns,
  type EcosystemVersionDeclarationPattern,
} from "./ecosystems.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { expandedQueryTermGroups, expandedQueryTerms } from "./repoSearchQueryTerms.js";
import { regexSafetyIssue } from "./repoSearchRegexSafety.js";
import { repositoryRouteDeclarationMatches, repositoryRouteQuery } from "./repoSearchRoutes.js";
import {
  repositorySourceLines,
  repositoryStructuralLine,
  type RepositorySourceLine,
} from "./repoSearchSourceClassification.js";

export interface LineMatcher {
  readonly match: (line: string, sourceLine?: RepositorySourceLine) => number;
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
// planner's fixed English/German stop-word policy (planner/anchors.ts in keiko-workflows - duplicated
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
  "definieren",
  "definiert",
  "declare",
  "declared",
  "declaration",
  "deklariert",
  "implement",
  "implements",
  "implemented",
  "implementation",
  "implementieren",
  "implementiert",
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

const LEADING_NON_ALNUM_RE = /^[^\p{L}\p{N}]+/u;

// Reverse a string by Unicode code point (not UTF-16 code unit), so surrogate pairs and
// combining marks stay intact — `Array.from` iterates by code point, matching how `\p{L}`/`\p{N}`
// classify characters under the regex `u` flag.
function reverseByCodePoint(value: string): string {
  return Array.from(value).reverse().join("");
}

// Strip leading/trailing non-alphanumeric characters (Unicode-aware) while preserving internal
// punctuation such as the hyphen in "ADR-0022" or the dot in "file.ts".
//
// The trailing strip used to be a second pattern, `[^\p{L}\p{N}]+$` — despite the comment this
// replaced, that one is NOT fully anchored (no `^`), so the engine retries the match at every
// position inside a long non-alphanumeric run before concluding there is no match at the string's
// end: quadratic in input length (SonarCloud S8786, confirmed empirically). The leading pattern
// above IS safe (the `^` pins the single start position), so the trailing strip now reuses it by
// reversing the string, stripping the (now-leading) run, and reversing back.
// Exported for the co-located regression test only — not part of the package's public surface
// (index.ts does not re-export anything from this module).
export function normalizeNaturalLanguageToken(raw: string): string {
  const leadingStripped = raw.replace(LEADING_NON_ALNUM_RE, "");
  const reversed = reverseByCodePoint(leadingStripped).replace(LEADING_NON_ALNUM_RE, "");
  return reverseByCodePoint(reversed);
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

// Memoized: `shouldScoreContent` calls this once per scanned FILE (repoSearchScan.ts), and each
// call re-tokenizes the query and re-tests every ecosystem routing regex in TECHNICAL_PHRASES —
// measurably the hottest per-file cost on large scans. The derivation is pure in
// (queryText, caseSensitive); the key marker char cannot collide with query text because the
// query is the key SUFFIX after a fixed two-char prefix.
const memoizedContentTerms: (key: string) => readonly string[] = memoizeByStringKey(
  8,
  (key: string): readonly string[] => {
    const caseSensitive = key.startsWith("s");
    const queryText = key.slice(2);
    return uniqueStrings(naturalLanguageContentTermGroups(queryText, caseSensitive).flat());
  },
);

const memoizedContentTermGroups: (key: string) => readonly (readonly string[])[] =
  memoizeByStringKey(8, (key: string): readonly (readonly string[])[] => {
    const caseSensitive = key.startsWith("s");
    const queryText = key.slice(2);
    const groups = naturalLanguageContentGroups(
      expandedQueryTermGroups(queryText, caseSensitive),
      caseSensitive,
    ).map(uniqueStrings);
    return [
      ...groups,
      ...technicalPhraseTerms(queryText, caseSensitive).map((term) => [term] as const),
    ];
  });

export function naturalLanguageContentTermGroups(
  queryText: string,
  caseSensitive: boolean,
): readonly (readonly string[])[] {
  return memoizedContentTermGroups(`${caseSensitive ? "s" : "i"} ${queryText}`);
}

export function naturalLanguageContentTerms(
  queryText: string,
  caseSensitive: boolean,
): readonly string[] {
  return memoizedContentTerms(`${caseSensitive ? "s" : "i"} ${queryText}`);
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
  queryText: string,
): NaturalLanguageIntent {
  const lowered = normalizedTokens.map((t) => t.toLowerCase());
  const definitionIntent = lowered.some(isDefinitionIntentToken);
  const symbolTokens = uniqueStrings(
    normalizedTokens
      .filter((token) => {
        const lower = token.toLowerCase();
        if (DEFINITION_INTENT_TOKENS.has(lower)) return false;
        return (
          isSymbolLikeToken(token) ||
          (definitionIntent && token.length >= 2 && !NL_STOP_WORDS.has(lower))
        );
      })
      .map((t) => (caseSensitive ? t : t.toLowerCase())),
  );
  const route = repositoryRouteQuery(queryText);
  const routeTokens = uniqueStrings([
    ...normalizedTokens
      .filter((t) => t.includes("/"))
      .map((t) => (caseSensitive ? t : t.toLowerCase())),
    ...(route === undefined ? [] : [route.path]),
  ]);
  const httpMethods = uniqueStrings([
    ...lowered
      .filter((t) => HTTP_METHOD_TOKENS.has(t))
      .map((t) => (caseSensitive ? t : t.toLowerCase())),
    ...(route === undefined ? [] : [route.method]),
  ]);
  return { definitionIntent, symbolTokens, routeTokens, httpMethods };
}

function lineLooksLikeImport(line: string): boolean {
  return /^\s*import\b/u.test(line) || /^\s*export\s*\{/u.test(line);
}

const DECLARATION_MODIFIERS: ReadonlySet<string> = new Set([
  "async",
  "default",
  "declare",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
]);
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "enum",
]);

function leadingAsciiWord(text: string): string {
  let end = 0;
  while (end < text.length && /[A-Za-z]/u.test(text.charAt(end))) end += 1;
  return text.slice(0, end);
}

function consumeWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text.charAt(index))) index += 1;
  return index;
}

function lineLooksLikeDeclaration(line: string): boolean {
  let remaining = line.trimStart();
  if (remaining.startsWith("export") && /\s/u.test(remaining.charAt("export".length))) {
    remaining = remaining.slice(consumeWhitespace(remaining, "export".length));
  }
  for (;;) {
    const word = leadingAsciiWord(remaining);
    if (!DECLARATION_MODIFIERS.has(word) || !/\s/u.test(remaining.charAt(word.length))) break;
    remaining = remaining.slice(consumeWhitespace(remaining, word.length));
  }
  const keyword = leadingAsciiWord(remaining);
  return (
    DECLARATION_KEYWORDS.has(keyword) &&
    (remaining.length === keyword.length || !/\w/u.test(remaining.charAt(keyword.length)))
  );
}

const DEFINITION_MODIFIERS_PATTERN = String.raw`(?:(?:export|public|private|protected|internal|static|abstract|final|sealed|partial|data|open|override|virtual|readonly|async)\s+)*`;
const EXPLICIT_TYPED_VOID_MODIFIERS_PATTERN = String.raw`(?:(?:public|private|protected|internal|static|abstract|final|sealed|partial|override|virtual|extern|native|synchronized)\s+)+`;
const METHOD_RETURN_TYPE_PATTERN = String.raw`:\s*[^;{}\r\n]{1,500}`;
const TYPED_DECLARATION_TOKEN_PATTERN = String.raw`[A-Za-z_$][\w$<>,?.\[\]]*`;
const DEFINITION_IDENTIFIER_PATTERN = String.raw`([\p{ID_Start}_$](?:[\p{ID_Continue}$]|\u200C|\u200D)*)`;
const NON_TYPE_DECLARATION_TOKENS: ReadonlySet<string> = new Set([
  "await",
  "return",
  "throw",
  "yield",
  "new",
  "void",
  "typeof",
  "delete",
  "go",
  "defer",
  "instanceof",
  "in",
  "of",
  "else",
  "do",
  "case",
  "default",
  "with",
  "assert",
  "raise",
  "del",
  "not",
  "and",
  "or",
]);

const DEFINITION_CAPTURE_PATTERNS = [
  new RegExp(
    String.raw`\b${DEFINITION_MODIFIERS_PATTERN}function\s+${DEFINITION_IDENTIFIER_PATTERN}`,
    "giu",
  ),
  new RegExp(
    String.raw`\b${DEFINITION_MODIFIERS_PATTERN}(?:const|let|var)\s+${DEFINITION_IDENTIFIER_PATTERN}`,
    "giu",
  ),
  new RegExp(
    String.raw`\b${DEFINITION_MODIFIERS_PATTERN}(?:class|interface|type|enum|record|struct|trait|object)\s+${DEFINITION_IDENTIFIER_PATTERN}`,
    "giu",
  ),
  new RegExp(String.raw`\b${DEFINITION_IDENTIFIER_PATTERN}\s*[:=]\s*(?:async\s*)?\(`, "giu"),
  new RegExp(
    String.raw`\b${DEFINITION_MODIFIERS_PATTERN}(?:def|func|fn|fun)\s+${DEFINITION_IDENTIFIER_PATTERN}\s*\(`,
    "giu",
  ),
  new RegExp(
    String.raw`\bfunc\s*\([^()\r\n]{1,500}\)\s*${DEFINITION_IDENTIFIER_PATTERN}\s*\(`,
    "giu",
  ),
  new RegExp(String.raw`\btype\s+${DEFINITION_IDENTIFIER_PATTERN}\s+(?:struct|interface)\b`, "giu"),
  new RegExp(
    String.raw`\b${DEFINITION_MODIFIERS_PATTERN}void\s+${DEFINITION_IDENTIFIER_PATTERN}\s*\([^;{}]{0,2000}\)\s*(?:throws\s+[^;{}]{1,500}\s*)?(?:\{|=>)`,
    "giu",
  ),
  new RegExp(
    String.raw`\b${EXPLICIT_TYPED_VOID_MODIFIERS_PATTERN}(?:async\s+)?void\s+${DEFINITION_IDENTIFIER_PATTERN}\s*\([^;{}]{0,2000}\)\s*(?:throws\s+[^;{}]{1,500}\s*)?;`,
    "giu",
  ),
  new RegExp(
    String.raw`(?:^|[,{;]\s*)${DEFINITION_MODIFIERS_PATTERN}(?:get\s+|set\s+)?\*?${DEFINITION_IDENTIFIER_PATTERN}\s*\([^;{}]{0,2000}\)\s*(?:${METHOD_RETURN_TYPE_PATTERN}\s*)?(?:\{|=>)`,
    "giu",
  ),
  new RegExp(
    String.raw`(?:^|[,{;]\s*)${DEFINITION_MODIFIERS_PATTERN}(?:get\s+|set\s+)?\*?${DEFINITION_IDENTIFIER_PATTERN}\s*\([^;{}]{0,2000}\)\s*${METHOD_RETURN_TYPE_PATTERN}\s*;`,
    "giu",
  ),
] as const;
const TYPED_DEFINITION_CAPTURE_PATTERN = new RegExp(
  String.raw`(?:^|[;{}])\s*${DEFINITION_MODIFIERS_PATTERN}(${TYPED_DECLARATION_TOKEN_PATTERN}(?:\s+${TYPED_DECLARATION_TOKEN_PATTERN})*)\s+${DEFINITION_IDENTIFIER_PATTERN}\s*\(`,
  "giu",
);

function addDefinitionCaptures(line: string, pattern: RegExp, symbols: Set<string>): void {
  pattern.lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const symbol = match[1];
    if (symbol !== undefined) symbols.add(symbol);
  }
}

function addTypedDefinitionCaptures(line: string, symbols: Set<string>): void {
  TYPED_DEFINITION_CAPTURE_PATTERN.lastIndex = 0;
  for (const match of line.matchAll(TYPED_DEFINITION_CAPTURE_PATTERN)) {
    const typeExpression = match[1];
    const symbol = match[2];
    if (
      typeExpression !== undefined &&
      symbol !== undefined &&
      typeExpression.split(/\s+/u).every((token) => !NON_TYPE_DECLARATION_TOKENS.has(token))
    ) {
      symbols.add(symbol);
    }
  }
}

export function definitionSymbolsInStructuralLine(line: string): readonly string[] {
  const symbols = new Set<string>();
  for (const pattern of DEFINITION_CAPTURE_PATTERNS) addDefinitionCaptures(line, pattern, symbols);
  addTypedDefinitionCaptures(line, symbols);
  return [...symbols];
}

export function lineLooksLikeSymbolDefinition(
  line: string,
  symbolToken: string,
  caseSensitive: boolean,
): boolean {
  return structuralLineLooksLikeSymbolDefinition(
    repositoryStructuralLine(line),
    symbolToken,
    caseSensitive,
  );
}

export function structuralLineLooksLikeSymbolDefinition(
  structuralLine: string,
  symbolToken: string,
  caseSensitive: boolean,
): boolean {
  return definitionSymbolsInStructuralLine(structuralLine).some((symbol) =>
    caseSensitive
      ? symbol === symbolToken
      : symbol.toLocaleLowerCase("en-US") === symbolToken.toLocaleLowerCase("en-US"),
  );
}

function lineLooksLikeRouteDeclaration(
  codeHaystack: string,
  structuralHaystack: string,
  intent: NaturalLanguageIntent,
): boolean {
  const routeHit = intent.routeTokens.some((token) => codeHaystack.includes(token));
  return (
    routeHit &&
    intent.httpMethods.some((method) =>
      repositoryRouteDeclarationMatches(codeHaystack, method, structuralHaystack),
    )
  );
}

function adjustedDefinitionIntentScore(
  sourceLine: RepositorySourceLine,
  baseScore: number,
  intent: NaturalLanguageIntent,
  caseSensitive: boolean,
): number {
  const codeHaystack = caseSensitive ? sourceLine.code : sourceLine.code.toLowerCase();
  const structuralHaystack = caseSensitive
    ? sourceLine.structural
    : sourceLine.structural.toLowerCase();
  const routeBonus = lineLooksLikeRouteDeclaration(codeHaystack, structuralHaystack, intent)
    ? 0.65
    : 0;
  if (!intent.definitionIntent) return Math.min(1, baseScore + routeBonus);
  let bonus = routeBonus;
  let penalty = 0;
  for (const symbolToken of intent.symbolTokens) {
    if (!structuralHaystack.includes(symbolToken)) {
      continue;
    }
    if (
      structuralLineLooksLikeSymbolDefinition(sourceLine.structural, symbolToken, caseSensitive)
    ) {
      bonus = Math.max(bonus, 0.75);
    } else if (lineLooksLikeDeclaration(sourceLine.structural)) {
      bonus = Math.max(bonus, 0.55);
    } else if (lineLooksLikeImport(sourceLine.structural)) {
      penalty = Math.max(penalty, 0.2);
    }
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
  const intentTokens = expandedQueryTerms(query.text, true);
  const normalizedTokens = naturalLanguageNormalizedTokens(intentTokens);
  // GRD-033: dedupe alternatives inside each original-token group so aliases/stems improve recall
  // without making every alias an additional required term in `hits/total`.
  const tokenGroups = naturalLanguageContentTermGroups(query.text, query.caseSensitive);
  const intent = analyzeNaturalLanguageIntent(normalizedTokens, query.caseSensitive, query.text);
  // The ecosystem declaration-line patterns whose routing pattern matched this query (e.g. for a
  // Java question: maven.compiler/java.version; for a Go question: go/toolchain directives).
  const versionDeclarationPatterns = ecosystemVersionDeclarationPatterns.filter((p) =>
    p.routePattern.test(query.text),
  );
  const total = tokenGroups.length;
  return {
    match: (line: string, providedSourceLine?: RepositorySourceLine): number => {
      if (total === 0) {
        return 0;
      }
      const sourceLine = providedSourceLine ?? repositorySourceLines(line)[0];
      if (sourceLine === undefined) return 0;
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
        sourceLine,
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
