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
const PRESENTATION_PATTERNS: readonly RegExp[] = [
  /,\s*with\s+(?:(?:current|relevant|supporting)\s+)?(?:implementation|definition|code|source)\s+citations\s*(?=$|[.!?;\n])/giu,
  /(^|[.!?;\n])\s*(?:please\s+)?cite(?:\s+(?:the|a|an|any|authoritative|relevant|supporting|source|sources|manual|manuals|file|files|and|line|lines|evidence|(?:implementation|definition|code)\s+lines?)){1,16}\b(?:,\s*(?:under|below|within)\s+\d{1,6}\s+(?:words|sentences|lines)\b)?/giu,
  /(^|[.!?;\n])\s*(?:please\s+)?keep\s+(?:(?:the|your)\s+answer|it)\s+(?:under|below|within)\s+\d{1,6}\s+(?:words|sentences|lines)\b/giu,
  /(^|[.!?;\n])\s*(?:please\s+)?(?:answer|respond)\s+(?:briefly|concisely)\b/giu,
  /(^|[.!?;\n])\s*(?:bitte\s+)?antworte\s+(?:kurz|knapp)(?:\s+mit\s+(?:quellenangabe|quellen|belegen))?\b/giu,
  /(^|[.!?;\n])\s*(?:bitte\s+)?zitiere(?:\s+(?:die|relevanten|quellen|quellzeilen|implementierungszeilen|definitionszeilen|zeilen|und)){1,16}\b(?:,\s*(?:unter|innerhalb\s+von)\s+\d{1,6}\s+(?:wörtern|sätzen|zeilen)\b)?/giu,
];
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
const FILENAME_RE =
  /(?<![\p{L}\p{M}\p{N}_$.-])([\p{L}\p{N}_$-][\p{L}\p{M}\p{N}_$-]{0,254}(?:\.[A-Za-z0-9]{1,16}){1,4})(?![\p{L}\p{M}\p{N}_$-]|\.[\p{L}\p{M}\p{N}_$-])/gu;
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}_.]+/u;
// Bare "next" is ordinary grammar unless a framework spelling or technical noun/use binds it.
// Intent classification consumes this same non-global pattern; it is not a public root export.
export const NEXT_FRAMEWORK_TERM_RE =
  /\bnext(?:\.?js)\b|\bnext(?=\s+(?:framework|version|configuration|config|router|app|application)\b)|\b(?:use|uses|using|with)\s+next(?=\s*[.!?]?\s*$)|^\s*next\s*$/iu;
const TECHNICAL_TERM_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly term: string;
}[] = [
  { pattern: /\btype[\s_-]?script\b/gi, term: "typescript" },
  { pattern: /\bjava[\s_-]?script\b/gi, term: "javascript" },
  { pattern: /\bnode(?:\.js)?\b/gi, term: "node" },
  { pattern: new RegExp(NEXT_FRAMEWORK_TERM_RE.source, "giu"), term: "nextjs" },
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
  /** Original path spelling for filesystem resolution; `term` remains the lexical key. */
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

function collectTechnicalTerms(source: string, out: AnchorAccumulator): string {
  let remaining = source;
  for (const entry of TECHNICAL_TERM_PATTERNS) {
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

function withoutPresentationInstructions(source: string): string {
  return PRESENTATION_PATTERNS.reduce(
    (remaining, pattern) => remaining.replace(pattern, (match) => " ".repeat(match.length)),
    source,
  );
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
    ...(a.kind === "path" && a.sourceTerm !== a.term ? { sourceTerm: a.sourceTerm } : {}),
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
