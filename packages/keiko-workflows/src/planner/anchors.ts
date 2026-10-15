import { isNumberedCompoundQueryTerm } from "@oscharko-dev/keiko-workspace";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

// Deterministic search-anchor extraction for the exploration planner (Epic #177, Issue #181).
// Pure JS — no IO, no clock, no randomness. Given free-form prompt text, this module produces
// a small, stable, weight-ordered set of search anchors. The stop-word list is intentionally
// fixed and bilingual (English/German) so supported prompts remain deterministic.

// The matcher limits literal target metadata, not surrounding question/specification text.
const MAX_ANCHOR_CHARACTERS = 4096;

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

// Identifier and path patterns bound backtracking at each start position, so the full admitted
// question can be inspected without discarding targets after a fixed prefix.
const QUOTED_DOUBLE_RE = /"([^"\n]+)"/g;
// Apostrophes stay inside alphabetic words; only unspaced CJK scripts may border a quote.
const QUOTED_SINGLE_RE =
  /(?<!(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{M}\p{N}_])'([^'\n]+)'(?!(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{M}\p{N}_])/gu;
const BACKTICK_RE = /`([^`\n]+)`/g;
const DOCUMENT_REFERENCE_RE = /\b((?:ADR|RFC)-\d{3,6})\b/gi;
// Inspect complete whitespace-delimited tokens once. Depth/segment regex bounds used to
// silently turn valid long or Unicode paths into suffixes; the existing total metadata budget
// remains authoritative. No nested repetition or rescanning from every slash is necessary.
const PATH_TOKEN_RE = /[^\s`"'<>,;!?]+/gu;
const PRESENTATION_BOUNDARY_RE = /[.!?;\n]/u;
const PRESENTATION_WHITESPACE_RE = /\s/u;
const PLEASE_RE = /please/iuy;
const GERMAN_PLEASE_RE = /bitte/iuy;
const WITH_RE = /with/iuy;
const SOURCE_QUALIFIER_RE = /(?:current|relevant|supporting)/iuy;
const SOURCE_KIND_RE = /(?:implementation|definition|code|source)/iuy;
const CITATIONS_RE = /citations/iuy;
const CITE_RE = /cite/iuy;
const ENGLISH_CITATION_WORD_RE = /(?:the|a|an|any|authoritative|current|relevant|supporting)\b/iuy;
const ENGLISH_CITATION_SOURCE_RE = /(?:sources?|manuals?|files?|and|lines?|evidence)\b/iuy;
const SOURCE_LINES_RE = /(?:implementation|definition|code)\s+lines?\b/iuy;
const KEEP_RE = /keep/iuy;
const ANSWER_SUBJECT_RE = /(?:(?:the|your)\s+answer|it)/iuy;
const ENGLISH_LIMIT_RELATION_RE = /(?:under|below|within)/iuy;
const PRESENTATION_NUMBER_RE = /\d{1,6}/y;
const ENGLISH_LIMIT_UNIT_RE = /(?:words|sentences|lines)\b/iuy;
const ANSWER_RE = /(?:answer|respond)/iuy;
const BRIEFLY_RE = /(?:briefly|concisely)\b/iuy;
const GERMAN_ANSWER_RE = /antworte/iuy;
const GERMAN_BRIEF_RE = /(?:kurz|knapp)\b/iuy;
const GERMAN_WITH_RE = /mit/iuy;
const GERMAN_SOURCE_RE = /(?:quellenangabe|quellen|belegen)\b/iuy;
const GERMAN_CITE_RE = /zitiere/iuy;
const GERMAN_CITATION_WORD_RE =
  /(?:die|relevanten|quellen|quellzeilen|implementierungszeilen|definitionszeilen|zeilen|und)\b/iuy;
const GERMAN_LIMIT_RELATION_RE = /(?:unter|innerhalb\s+von)/iuy;
const GERMAN_LIMIT_UNIT_RE = /(?:wörtern|sätzen|zeilen)\b/iuy;
const API_ROUTE_RE =
  /(^|[^A-Za-z0-9_.:/-])((?:\/[A-Za-z0-9_.:{}%+*?&=-]{0,127}[A-Za-z0-9_}*-]){1,64})/g;
const DEFINITION_TARGET_BEFORE_VERB_RE =
  /\b([a-z_$][a-z0-9_$]{2,127})\s+(?:defined|declared|implemented|definiert|deklariert|implementiert)\b/giu;
const DEFINITION_TARGET_AFTER_VERB_RE =
  /\b(?:define|declare|implement|definieren|deklarieren|implementieren)\s+(?:(?:we|wir|ich|du|sie|man)\s+)?([a-z_$][a-z0-9_$]{2,127})\b/giu;
const DEFINITION_TARGET_AFTER_NOUN_RE =
  /\b(?:definition|declaration|implementation|deklaration|implementierung)\s+(?:(?:of|von)\s+)?([a-z_$][a-z0-9_$]{2,127})\b/giu;
// Requires a genuine lower/digit -> upper transition so all-caps acronyms and SHOUTING words
// (WHY, HTTP, BROKEN) are NOT mistaken for code identifiers. A spurious 0.85 identifier anchor
// would both satisfy the clarification gate for a vague question and seed symbol-file retrieval
// with a non-symbol — see planner/plan.ts decideClarification and grounded symbolFileAnchorTerms.
const CAMEL_IDENTIFIER_RE =
  /\b([A-Za-z_$][A-Za-z0-9_$]{0,127}[a-z0-9][A-Z][A-Za-z0-9_$]{0,127})\b/g;
const SNAKE_IDENTIFIER_RE = /\b([A-Za-z_$][A-Za-z0-9$]{0,127}_[A-Za-z0-9_$]{1,127})\b/g;
const COMPOUND_IDENTIFIER_TOKEN_RE = /[\p{L}\p{M}\p{N}_$.-]+/gu;
const FILENAME_RE =
  /(?<![\p{L}\p{M}\p{N}_$.-])([\p{L}\p{N}_$-][\p{L}\p{M}\p{N}_$-]{0,254}(?:\.[A-Za-z0-9]{1,16}){1,4})(?![\p{L}\p{M}\p{N}_$-]|\.[\p{L}\p{M}\p{N}_$-])/gu;
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}_.]+/u;
// Bare "next" is ordinary grammar unless a framework spelling or technical noun/use binds it.
// Intent classification consumes the same matcher; it is not a public root export.
const NEXT_TOKEN_RE = /\b(?:next(?:\.?js)?|uses?|using|with)\b/giu;
const NEXT_DIRECT_TOKEN_RE = /^next\.?js$/iu;
const NEXT_BARE_TOKEN_RE = /next/iuy;
const NEXT_CONTEXT_NOUN_RE =
  /(?:framework|version|configuration|config|router|app|application)\b/iuy;
const TECHNICAL_TERM_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly term: string;
}[] = [
  { pattern: /\btype[\s_-]?script\b/gi, term: "typescript" },
  { pattern: /\bjava[\s_-]?script\b/gi, term: "javascript" },
  { pattern: /\bnode(?:\.js)?\b/gi, term: "node" },
  { pattern: NEXT_TOKEN_RE, term: "nextjs" },
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
  /** Original spelling for case-sensitive hints or filesystem resolution; `term` is the lexical key. */
  readonly sourceTerm?: string;
  readonly weight: number;
  readonly kind: SearchAnchorKind;
}

export interface AnchorExtractionInput {
  readonly text: string;
  readonly maxAnchors: number;
  /** Keep source spelling for exact matching; planner routing defaults to normalized terms. */
  readonly caseSensitive?: boolean;
}

export interface AnchorExtractionResult {
  readonly anchors: readonly SearchAnchor[];
  readonly truncated: boolean;
  readonly tokensConsidered: number;
}

interface MutableAnchor {
  term: string;
  sourceTerm: string;
  weight: number;
  kind: SearchAnchorKind;
}

interface AnchorAccumulator {
  readonly anchors: MutableAnchor[];
  truncated: boolean;
}

const SENTENCE_PATH_SUFFIX = new Set([":", ";", ",", ".", "-"]);

function trimTrailingCharacters(value: string, characters: ReadonlySet<string>): string {
  let end = value.length;
  while (end > 0 && characters.has(value[end - 1] ?? "")) end -= 1;
  return value.slice(0, end);
}

function trimEdgeDots(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ".") start += 1;
  while (end > start && value[end - 1] === ".") end -= 1;
  return value.slice(start, end);
}

function pushAnchor(
  out: AnchorAccumulator,
  raw: string,
  kind: SearchAnchorKind,
  weight: number,
  sourceSpelling?: string,
): void {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_ANCHOR_CHARACTERS) {
    out.truncated = true;
    return;
  }
  const withoutSentencePunctuation =
    kind === "path" && trimmed.startsWith("/")
      ? trimTrailingCharacters(trimmed, SENTENCE_PATH_SUFFIX)
      : trimmed;
  const term = withoutSentencePunctuation.toLowerCase();
  if (term.length > 0) {
    out.anchors.push({
      term,
      sourceTerm: sourceSpelling ?? withoutSentencePunctuation,
      weight,
      kind,
    });
  }
}

function collectMatches(
  source: string,
  pattern: RegExp,
  kind: SearchAnchorKind,
  weight: number,
  out: AnchorAccumulator,
  accept: (value: string) => boolean = () => true,
  replacement?: string,
): string {
  const re = new RegExp(pattern.source, pattern.flags);
  const parts: string[] = [];
  let cursor = 0;
  let match = re.exec(source);
  while (match !== null) {
    const full = match[0];
    const captured = match[2] ?? match[1] ?? full;
    parts.push(source.slice(cursor, match.index));
    if (accept(captured)) {
      pushAnchor(out, captured, kind, weight);
      parts.push(replacement ?? " ".repeat(full.length));
    } else {
      parts.push(full);
    }
    cursor = match.index + full.length;
    match = re.exec(source);
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function isDefinitionTarget(value: string): boolean {
  return !STOP_WORDS.has(value.toLowerCase());
}

function collectNumberedCompoundHints(source: string, out: AnchorAccumulator): string {
  return source.replace(COMPOUND_IDENTIFIER_TOKEN_RE, (raw) => {
    const term = trimEdgeDots(raw);
    // Shape alone cannot distinguish a named subject from a technical alias or an adjective.
    // Keep the whole spelling as a hint without granting exact-target or symbol authority.
    if (!isNumberedCompoundQueryTerm(term)) return raw;
    pushAnchor(out, term, "literal", 0.85, term);
    return " ".repeat(raw.length);
  });
}

function collectTechnicalTerms(source: string, out: AnchorAccumulator): string {
  let remaining = source;
  for (const entry of TECHNICAL_TERM_PATTERNS) {
    if (entry.term === "nextjs") {
      remaining = collectNextFrameworkTerms(remaining, out);
      continue;
    }
    const re = new RegExp(entry.pattern.source, entry.pattern.flags);
    const parts: string[] = [];
    let cursor = 0;
    let match = re.exec(remaining);
    while (match !== null) {
      const full = match[0];
      pushAnchor(out, entry.term, "identifier", 0.85, full);
      parts.push(remaining.slice(cursor, match.index), " ".repeat(full.length));
      cursor = match.index + full.length;
      match = re.exec(remaining);
    }
    parts.push(remaining.slice(cursor));
    remaining = parts.join("");
  }
  return remaining;
}

function tokenizeRemaining(remaining: string, out: AnchorAccumulator): number {
  let considered = 0;
  for (const raw of remaining.split(TOKEN_SPLIT_RE)) {
    const normalizedRaw = trimEdgeDots(raw);
    if (normalizedRaw.length === 0) {
      continue;
    }
    if (normalizedRaw.length > MAX_ANCHOR_CHARACTERS) {
      out.truncated = true;
      continue;
    }
    considered += 1;
    const token = normalizedRaw.toLowerCase();
    if (token.length < 3) {
      continue;
    }
    if (STOP_WORDS.has(token)) {
      continue;
    }
    if (token.includes(".")) {
      out.anchors.push({ term: token, sourceTerm: normalizedRaw, weight: 0.8, kind: "identifier" });
      continue;
    }
    out.anchors.push({ term: token, sourceTerm: normalizedRaw, weight: 0.5, kind: "literal" });
  }
  return considered;
}

function completePathToken(raw: string): string {
  const term = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (term.startsWith("(") && term.endsWith(")")) return term.slice(1, -1);
  return term.endsWith(")") ? term.slice(0, -1) : term;
}

function isFilePathToken(term: string): boolean {
  const path = term.replace(/(?::\d{1,9}){1,2}$/u, "");
  if (!path.includes("/") || path.includes("\\")) return false;
  const localPath = path.startsWith("file://") ? path.slice(7) : path;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(localPath)) return false;
  const name = localPath.slice(localPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && /^[A-Za-z0-9]{1,16}$/u.test(name.slice(dot + 1));
}

// The composer emits @path as a reference marker. Quotes have already been consumed here;
// quoted literal @ paths and an explicit ./@ path therefore retain their filesystem spelling.
export function normalizeUnquotedFilePathToken(term: string): string {
  const withoutMention = term.startsWith("@") ? term.slice(1) : term;
  return isFilePathToken(withoutMention) ? withoutMention : term;
}

function collectFilePathTokens(source: string, out: AnchorAccumulator): string {
  return source.replace(PATH_TOKEN_RE, (raw: string) => {
    const term = normalizeUnquotedFilePathToken(completePathToken(raw));
    if (!isFilePathToken(term)) return raw;
    pushAnchor(out, term, "path", 0.95);
    return raw.endsWith(".") ? `${" ".repeat(raw.length - 1)}.` : " ".repeat(raw.length);
  });
}

function skipPresentationWhitespace(source: string, start: number): number {
  let end = start;
  while (PRESENTATION_WHITESPACE_RE.test(source.charAt(end))) end += 1;
  return end;
}

function presentationTokenEnd(source: string, start: number, pattern: RegExp): number | undefined {
  pattern.lastIndex = start;
  const match = pattern.exec(source);
  return match === null ? undefined : start + match[0].length;
}

function spacedPresentationTokenEnd(
  source: string,
  start: number,
  pattern: RegExp,
): number | undefined {
  const tokenEnd = presentationTokenEnd(source, start, pattern);
  if (tokenEnd === undefined) return undefined;
  const end = skipPresentationWhitespace(source, tokenEnd);
  return end === tokenEnd ? undefined : end;
}

function presentationSequenceEnd(
  source: string,
  start: number,
  patterns: readonly RegExp[],
): number | undefined {
  let end = start;
  for (const pattern of patterns) {
    const next = spacedPresentationTokenEnd(source, end, pattern);
    if (next === undefined) return undefined;
    end = next;
  }
  return end;
}

function withCitationsEnd(source: string, start: number): number | undefined {
  const withEnd = spacedPresentationTokenEnd(source, start, WITH_RE);
  if (withEnd === undefined) return undefined;
  const qualified = spacedPresentationTokenEnd(source, withEnd, SOURCE_QUALIFIER_RE) ?? withEnd;
  const kindEnd = spacedPresentationTokenEnd(source, qualified, SOURCE_KIND_RE);
  if (kindEnd === undefined) return undefined;
  const citationsEnd = presentationTokenEnd(source, kindEnd, CITATIONS_RE);
  if (citationsEnd === undefined) return undefined;
  const end = skipPresentationWhitespace(source, citationsEnd);
  if (end === source.length || PRESENTATION_BOUNDARY_RE.test(source.charAt(end))) return end;
  // The former trailing whitespace could backtrack to the last LF before another sentence.
  const newline = source.slice(citationsEnd, end).lastIndexOf("\n");
  return newline < 0 ? undefined : citationsEnd + newline;
}

function citationTermsEnd(
  source: string,
  start: number,
  words: readonly RegExp[],
): number | undefined {
  let end = start;
  for (let count = 0; count < 16; count += 1) {
    const next = skipPresentationWhitespace(source, end);
    if (next === end) break;
    const termEnd = words
      .map((pattern) => presentationTokenEnd(source, next, pattern))
      .find((value) => value !== undefined);
    if (termEnd === undefined) break;
    end = termEnd;
  }
  return end === start ? undefined : end;
}

function citationLimitEnd(source: string, start: number, german: boolean): number | undefined {
  if (source.charAt(start) !== ",") return undefined;
  const numberEnd = presentationSequenceEnd(source, skipPresentationWhitespace(source, start + 1), [
    german ? GERMAN_LIMIT_RELATION_RE : ENGLISH_LIMIT_RELATION_RE,
    PRESENTATION_NUMBER_RE,
  ]);
  const unitPattern = german ? GERMAN_LIMIT_UNIT_RE : ENGLISH_LIMIT_UNIT_RE;
  return numberEnd === undefined ? undefined : presentationTokenEnd(source, numberEnd, unitPattern);
}

function citeEnd(source: string, start: number, german = false): number | undefined {
  const commandStart =
    spacedPresentationTokenEnd(source, start, german ? GERMAN_PLEASE_RE : PLEASE_RE) ?? start;
  const commandEnd = presentationTokenEnd(source, commandStart, german ? GERMAN_CITE_RE : CITE_RE);
  if (commandEnd === undefined) return undefined;
  const end = citationTermsEnd(
    source,
    commandEnd,
    german
      ? [GERMAN_CITATION_WORD_RE]
      : [ENGLISH_CITATION_WORD_RE, ENGLISH_CITATION_SOURCE_RE, SOURCE_LINES_RE],
  );
  return end === undefined ? undefined : (citationLimitEnd(source, end, german) ?? end);
}

function keepAnswerEnd(source: string, start: number): number | undefined {
  const commandStart = spacedPresentationTokenEnd(source, start, PLEASE_RE) ?? start;
  const end = presentationSequenceEnd(source, commandStart, [
    KEEP_RE,
    ANSWER_SUBJECT_RE,
    ENGLISH_LIMIT_RELATION_RE,
    PRESENTATION_NUMBER_RE,
  ]);
  return end === undefined ? undefined : presentationTokenEnd(source, end, ENGLISH_LIMIT_UNIT_RE);
}

function briefAnswerEnd(source: string, start: number): number | undefined {
  const commandStart = spacedPresentationTokenEnd(source, start, PLEASE_RE) ?? start;
  const end = spacedPresentationTokenEnd(source, commandStart, ANSWER_RE);
  return end === undefined ? undefined : presentationTokenEnd(source, end, BRIEFLY_RE);
}

function germanBriefAnswerEnd(source: string, start: number): number | undefined {
  const commandStart = spacedPresentationTokenEnd(source, start, GERMAN_PLEASE_RE) ?? start;
  const answerEnd = spacedPresentationTokenEnd(source, commandStart, GERMAN_ANSWER_RE);
  if (answerEnd === undefined) return undefined;
  const end = presentationTokenEnd(source, answerEnd, GERMAN_BRIEF_RE);
  if (end === undefined) return undefined;
  const withEnd = spacedPresentationTokenEnd(
    source,
    skipPresentationWhitespace(source, end),
    GERMAN_WITH_RE,
  );
  return withEnd === undefined
    ? end
    : (presentationTokenEnd(source, withEnd, GERMAN_SOURCE_RE) ?? end);
}

type PresentationMatcher = (source: string, start: number) => number | undefined;

function maskPresentationInstruction(
  source: string,
  matcher: PresentationMatcher,
  commaBoundary = false,
): string {
  const parts: string[] = [];
  let cursor = 0;
  let keptUntil = 0;
  while (cursor < source.length) {
    const punctuation = PRESENTATION_BOUNDARY_RE.test(source.charAt(cursor));
    const boundary = commaBoundary ? source.charAt(cursor) === "," : cursor === 0 || punctuation;
    if (!boundary) {
      cursor += 1;
      continue;
    }
    const start = skipPresentationWhitespace(
      source,
      cursor + (commaBoundary || punctuation ? 1 : 0),
    );
    const end = matcher(source, start);
    if (end === undefined) {
      cursor = Math.max(cursor + 1, start);
      continue;
    }
    parts.push(source.slice(keptUntil, cursor), " ".repeat(end - cursor));
    keptUntil = end;
    cursor = end;
  }
  parts.push(source.slice(keptUntil));
  return parts.join("");
}

function withoutPresentationInstructions(source: string): string {
  const withoutCitations = maskPresentationInstruction(source, withCitationsEnd, true);
  return [
    citeEnd,
    keepAnswerEnd,
    briefAnswerEnd,
    germanBriefAnswerEnd,
    (text: string, start: number): number | undefined => citeEnd(text, start, true),
  ].reduce(
    (remaining, matcher) => maskPresentationInstruction(remaining, matcher),
    withoutCitations,
  );
}

interface NextFrameworkMatch {
  readonly start: number;
  readonly end: number;
}

function standaloneNext(source: string): boolean {
  const end = presentationTokenEnd(
    source,
    skipPresentationWhitespace(source, 0),
    NEXT_BARE_TOKEN_RE,
  );
  return end !== undefined && skipPresentationWhitespace(source, end) === source.length;
}

function terminalNextPunctuation(source: string, start: number): boolean {
  const end = skipPresentationWhitespace(source, start);
  const punctuation = source.charAt(end);
  const afterPunctuation =
    punctuation === "." || punctuation === "!" || punctuation === "?" ? end + 1 : end;
  return skipPresentationWhitespace(source, afterPunctuation) === source.length;
}

function nextTokenEnd(source: string, start: number, token: string): number | undefined {
  if (NEXT_DIRECT_TOKEN_RE.test(token)) return start + token.length;
  if (/^next$/iu.test(token)) {
    const nounStart = spacedPresentationTokenEnd(source, start, NEXT_BARE_TOKEN_RE);
    return nounStart !== undefined &&
      presentationTokenEnd(source, nounStart, NEXT_CONTEXT_NOUN_RE) !== undefined
      ? start + token.length
      : undefined;
  }
  const following = skipPresentationWhitespace(source, start + token.length);
  if (following === start + token.length) return undefined;
  const end = presentationTokenEnd(source, following, NEXT_BARE_TOKEN_RE);
  return end !== undefined && terminalNextPunctuation(source, end) ? end : undefined;
}

function nextFrameworkMatches(source: string): readonly NextFrameworkMatch[] {
  if (standaloneNext(source)) return [{ start: 0, end: source.length }];
  const matches: NextFrameworkMatch[] = [];
  const pattern = new RegExp(NEXT_TOKEN_RE.source, NEXT_TOKEN_RE.flags);
  for (const match of source.matchAll(pattern)) {
    const end = nextTokenEnd(source, match.index, match[0]);
    if (end === undefined) continue;
    matches.push({ start: match.index, end });
  }
  return matches;
}

export function matchesNextFrameworkTerm(source: string): boolean {
  return nextFrameworkMatches(source).length > 0;
}

function collectNextFrameworkTerms(source: string, out: AnchorAccumulator): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of nextFrameworkMatches(source)) {
    pushAnchor(out, "nextjs", "identifier", 0.85, source.slice(match.start, match.end));
    parts.push(source.slice(cursor, match.start), " ".repeat(match.end - match.start));
    cursor = match.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function dedup(anchors: readonly MutableAnchor[], caseSensitive: boolean): MutableAnchor[] {
  const best = new Map<string, MutableAnchor>();
  for (const anchor of anchors) {
    const key = caseSensitive ? anchor.sourceTerm : anchor.term;
    const existing = best.get(key);
    if (existing === undefined || anchor.weight > existing.weight) {
      best.set(key, { ...anchor });
    }
  }
  return Array.from(best.values());
}

function sortAnchors(anchors: MutableAnchor[]): MutableAnchor[] {
  return anchors.sort((a, b) => {
    if (a.weight !== b.weight) {
      return b.weight - a.weight;
    }
    return compareStrings(a.term, b.term);
  });
}

function freeze(
  anchors: readonly MutableAnchor[],
  caseSensitive: boolean,
): readonly SearchAnchor[] {
  return anchors.map((a) => ({
    term: caseSensitive ? a.sourceTerm : a.term,
    ...((a.kind === "path" || (a.kind === "literal" && isNumberedCompoundQueryTerm(a.term))) &&
    a.sourceTerm !== a.term
      ? { sourceTerm: a.sourceTerm }
      : {}),
    weight: a.weight,
    kind: a.kind,
  }));
}

function collectQuotedTargets(
  text: string,
  collected: AnchorAccumulator,
  replacement?: string,
  accept: (value: string) => boolean = () => true,
): string {
  let remaining = collectMatches(
    text,
    QUOTED_DOUBLE_RE,
    "quoted",
    1,
    collected,
    accept,
    replacement,
  );
  remaining = collectMatches(
    remaining,
    QUOTED_SINGLE_RE,
    "quoted",
    1,
    collected,
    accept,
    replacement,
  );
  return collectMatches(remaining, BACKTICK_RE, "identifier", 0.9, collected, accept, replacement);
}

// Internal planner seam: quoted targets and output directives cannot create content intent.
// Extraction and classification share the quotation and presentation grammar.
export function queryContextOutsideQuotes(text: string): string {
  return withoutPresentationInstructions(
    collectQuotedTargets(text, { anchors: [], truncated: false }),
  );
}

// Same quote parser as extraction: the marker denotes accepted target data, never query prose.
export function queryShapeOutsideTargets(text: string, targets: readonly SearchAnchor[]): string {
  const terms = new Set(targets.map((target) => target.term));
  const shape = collectQuotedTargets(text, { anchors: [], truncated: false }, " \0 ", (value) =>
    terms.has(value.trim().toLowerCase()),
  );
  return withoutPresentationInstructions(shape).replace(/[\p{L}\p{N}_$-]+/gu, (token) =>
    terms.has(token.toLowerCase()) ? " \0 " : token,
  );
}

export function extractAnchors(input: AnchorExtractionInput): AnchorExtractionResult {
  const { text, maxAnchors, caseSensitive = false } = input;
  if (text.length === 0) {
    return { anchors: [], truncated: false, tokensConsidered: 0 };
  }
  const collected: AnchorAccumulator = { anchors: [], truncated: false };
  let remaining = collectQuotedTargets(text, collected);
  remaining = collectMatches(remaining, DOCUMENT_REFERENCE_RE, "identifier", 0.95, collected);
  remaining = collectFilePathTokens(remaining, collected);
  remaining = collectMatches(remaining, API_ROUTE_RE, "path", 0.95, collected);
  // Explicit target data has already been retained. Remove presentation prose before definition
  // patterns can promote words such as "lines" into independently requested source symbols.
  remaining = withoutPresentationInstructions(remaining);
  remaining = collectNumberedCompoundHints(remaining, collected);
  remaining = collectMatches(
    remaining,
    DEFINITION_TARGET_BEFORE_VERB_RE,
    "identifier",
    0.85,
    collected,
    isDefinitionTarget,
  );
  remaining = collectMatches(
    remaining,
    DEFINITION_TARGET_AFTER_VERB_RE,
    "identifier",
    0.85,
    collected,
    isDefinitionTarget,
  );
  remaining = collectMatches(
    remaining,
    DEFINITION_TARGET_AFTER_NOUN_RE,
    "identifier",
    0.85,
    collected,
    isDefinitionTarget,
  );
  // Consume compound filenames before their snake/kebab fragments. Simple dotted technical
  // aliases still reach the canonical technical-term pass below.
  remaining = collectMatches(remaining, FILENAME_RE, "identifier", 0.8, collected, (value) =>
    /[_-]/u.test(value),
  );
  remaining = collectMatches(remaining, CAMEL_IDENTIFIER_RE, "identifier", 0.85, collected);
  remaining = collectMatches(remaining, SNAKE_IDENTIFIER_RE, "identifier", 0.85, collected);
  remaining = collectTechnicalTerms(remaining, collected);
  const tokensConsidered = tokenizeRemaining(remaining, collected);
  const selected = selectBoundedAnchors(collected, maxAnchors, caseSensitive);
  return { ...selected, tokensConsidered };
}

function selectBoundedAnchors(
  collected: AnchorAccumulator,
  maxAnchors: number,
  caseSensitive: boolean,
): Omit<AnchorExtractionResult, "tokensConsidered"> {
  const sorted = freeze(sortAnchors(dedup(collected.anchors, caseSensitive)), caseSensitive);
  const selected: SearchAnchor[] = [];
  let characters = 0;
  let truncated = collected.truncated;
  for (const anchor of sorted) {
    const nextCharacters = characters + anchor.term.length + Number(selected.length > 0);
    if (selected.length >= maxAnchors || nextCharacters > MAX_ANCHOR_CHARACTERS) {
      truncated = true;
      continue;
    }
    selected.push(anchor);
    characters = nextCharacters;
  }
  return { anchors: selected, truncated };
}
