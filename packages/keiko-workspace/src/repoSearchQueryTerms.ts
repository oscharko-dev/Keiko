// Deterministic query-term expansion for repository retrieval. Kept in keiko-workspace so both
// candidate ordering and line matching interpret code-shaped prompts the same way.

import { withoutAnswerPresentationInstructions } from "./repoSearchPresentation.js";
import { stripTestIdentifierSuffix } from "./repoSearchIdentifier.js";

const QUERY_TOKEN_RE = /[\p{L}\p{N}_$@./:-]+/gu;
const TOKEN_SEPARATOR_RE = /[/@.:\-_]+/u;
const STACK_LOCATION_SUFFIX_RE = /^(.+?):\d+(?::\d+)?$/u;
const ATOMIC_DOCUMENT_REFERENCE_RE = /^(?:adr|rfc)-\d{3,6}$/iu;
const NUMBERED_COMPOUND_TERM_RE = /^\p{L}[\p{L}\p{M}\p{N}]*(?:-[\p{L}\p{M}\p{N}]+)+$/u;

/** A lexical shape hint, never authority to require an exact source or code symbol. */
export function isNumberedCompoundQueryTerm(term: string): boolean {
  return /\p{N}/u.test(term) && NUMBERED_COMPOUND_TERM_RE.test(term);
}

/** Whole lexical spelling; Unicode word characters and compound continuations are not boundaries. */
export function containsNumberedCompoundQueryTerm(
  content: string,
  term: string,
  caseSensitive = false,
): boolean {
  if (!isNumberedCompoundQueryTerm(term)) return false;
  const spelling = caseSensitive ? term : term.toLowerCase();
  const haystack = caseSensitive ? content : content.toLowerCase();
  // The validated shape contains only letters, marks, numbers and hyphens, so it is regex-literal.
  return new RegExp(
    String.raw`(?:^|[^\p{L}\p{M}\p{N}_-])${spelling}(?![\p{L}\p{M}\p{N}_-])`,
    "u",
  ).test(haystack);
}

export const MAX_EXPANDED_QUERY_TERMS = 48;

const CITATION_DIRECTIVE_VERBS: ReadonlySet<string> = new Set([
  "cite",
  "include",
  "provide",
  "zitiere",
  "nenne",
]);
const CITATION_DIRECTIVE_TERMS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "with",
  "source",
  "sources",
  "implementation",
  "file",
  "files",
  "path",
  "paths",
  "line",
  "lines",
  "number",
  "numbers",
  "citation",
  "citations",
  "die",
  "und",
  "mit",
  "quelle",
  "quellen",
  "datei",
  "dateien",
  "pfad",
  "pfade",
  "zeile",
  "zeilen",
  "zeilennummer",
  "zeilennummern",
  "implementierungsdateien",
]);
const CITATION_TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([".", "!", "?", ";"]);

function withoutTrailingCitationPunctuation(word: string): string {
  let end = word.length;
  while (end > 0 && CITATION_TRAILING_PUNCTUATION.has(word.charAt(end - 1))) end -= 1;
  return word.slice(0, end);
}

function isCitationOnlyDirective(clause: string): boolean {
  if (!/^\s*\p{L}/u.test(clause) || /["'`“”‘’«»]/u.test(clause)) return false;
  const words = clause.match(/[\p{L}\p{N}_$./:-]+/gu) ?? [];
  const verb = words.shift()?.toLowerCase();
  const german = verb === "zitiere" || verb === "nenne";
  return (
    verb !== undefined &&
    CITATION_DIRECTIVE_VERBS.has(verb) &&
    words.length > 0 &&
    words.every(
      (word) =>
        (german || word === word.toLowerCase()) &&
        CITATION_DIRECTIVE_TERMS.has(withoutTrailingCitationPunctuation(word.toLowerCase())),
    )
  );
}

interface NaturalLanguageSubject {
  readonly text: string;
  readonly citationDirectiveClauseCount: number;
}

/** Pure citation-format clauses are not source subjects; unknown or named clauses stay intact. */
export function naturalLanguageSubject(text: string): NaturalLanguageSubject {
  const unchanged = { text, citationDirectiveClauseCount: 0 };
  if (/["'`“”‘’«»]/u.test(text)) return unchanged;
  const clauses = text.split(/(?<=[.!?;])\s+|\n+/u);
  const retained = clauses.filter((clause) => !isCitationOnlyDirective(clause));
  if (retained.length === 0) return unchanged;
  const subject = retained.length === clauses.length ? text : retained.join(" ");
  const normalized = withoutAnswerPresentationInstructions(subject);
  if (!/[\p{L}\p{N}]/u.test(normalized)) return unchanged;
  return {
    text: normalized,
    citationDirectiveClauseCount: clauses.length - retained.length,
  };
}

export function naturalLanguageSubjectText(text: string): string {
  return naturalLanguageSubject(text).text;
}

const EVIDENCE_ONLY_USE_DIRECTIVE_PATTERNS = [
  /\buse\s+only\s+(?:read|verified|cited)\s+(?:values|evidence|sources)\b/giu,
  /\bverwende\s+nur\s+(?:gelesene|belegte|verifizierte)\s+(?:werte|evidenz|quellen)\b/giu,
];

/** Evidence restrictions do not request source-code uses; mixed subject clauses remain. */
export function withoutEvidenceOnlyUseDirectives(text: string): string {
  return EVIDENCE_ONLY_USE_DIRECTIVE_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, " "),
    text,
  );
}

const DOMAIN_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["abhängigkeit", ["dependency", "dependencies"]],
  ["arbeit", ["work"]],
  ["aufruf", ["call", "invoke", "invocation"]],
  ["aufrufen", ["call", "invoke"]],
  ["auth", ["authentication", "authorize", "authorization", "login", "signin", "token", "jwt"]],
  ["authn", ["authentication", "login", "signin"]],
  ["authz", ["authorization", "permission", "policy", "role"]],
  ["authenticate", ["authentication", "auth", "login", "signin"]],
  ["authentication", ["auth", "authenticate", "login", "signin", "authn"]],
  ["authorization", ["authz", "permission", "policy", "role"]],
  ["autonomie", ["autonomy"]],
  ["beleg", ["evidence"]],
  ["belegenden", ["evidence"]],
  ["failure", ["fail", "failed", "error", "exception", "crash"]],
  ["failed", ["fail", "failure", "error", "exception", "crash"]],
  ["failing", ["fail", "failure", "error", "exception", "crash"]],
  ["front-end", ["web", "ui", "client"]],
  ["frontend", ["web", "ui", "client"]],
  ["login", ["auth", "authenticate", "authentication", "signin", "token"]],
  ["oberflaeche", ["web", "ui", "client"]],
  ["oberfläche", ["web", "ui", "client"]],
  ["back-end", ["server", "api", "service"]],
  ["backend", ["server", "api", "service"]],
  ["infra", ["terraform", "kubernetes", "helm"]],
  ["infrastructure", ["terraform", "kubernetes", "helm"]],
  ["infrastruktur", ["terraform", "kubernetes", "helm"]],
  ["bug", ["failure", "error", "incorrect", "wrong", "regression"]],
  ["calculate", ["calculation", "compute", "computed", "sum", "total"]],
  ["calculation", ["calculate", "compute", "computed", "sum", "total"]],
  ["cart", ["checkout", "basket", "order", "purchase"]],
  ["checkout", ["cart", "basket", "order", "purchase", "payment"]],
  ["compute", ["calculate", "calculation", "computed"]],
  ["datei", ["file"]],
  ["dateien", ["file", "files"]],
  ["definieren", ["define", "defined", "definition", "declare"]],
  ["definiert", ["define", "defined", "definition", "declared"]],
  ["deklariert", ["declare", "declared", "declaration"]],
  ["drei", ["three"]],
  ["fehler", ["failure", "error", "bug"]],
  ["funktion", ["function"]],
  ["implementieren", ["implement", "implemented", "implementation"]],
  ["implementiert", ["implement", "implemented", "implementation"]],
  ["incorrect", ["wrong", "bug", "failure", "error"]],
  ["invariante", ["invariant"]],
  ["klasse", ["class"]],
  ["konfiguration", ["config", "configuration"]],
  ["modi", ["mode", "modes"]],
  ["modus", ["mode", "modes"]],
  ["paket", ["package"]],
  ["quelle", ["source"]],
  ["repository", ["repo", "codebase"]],
  ["total", ["sum", "amount", "subtotal", "grandtotal", "price"]],
  ["wrong", ["incorrect", "bug", "failure", "error", "regression"]],
]);

function toCaseSensitive(term: string): string {
  return term;
}

function toCaseInsensitive(term: string): string {
  return term.toLowerCase();
}

function addTerm(
  out: string[],
  seen: Set<string>,
  term: string,
  caseSensitive: boolean,
  minLength = 2,
): void {
  if (out.length >= MAX_EXPANDED_QUERY_TERMS) {
    return;
  }
  const trimmed = term.trim();
  if (trimmed.length < minLength || !/[\p{L}\p{N}]/u.test(trimmed)) {
    return;
  }
  const normalized = caseSensitive ? toCaseSensitive(trimmed) : toCaseInsensitive(trimmed);
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  out.push(normalized);
}

function stripStackLocationSuffix(token: string): string {
  if (!token.includes("/") && !token.includes(".")) {
    return token;
  }
  const match = STACK_LOCATION_SUFFIX_RE.exec(token);
  return match?.[1] ?? token;
}

function stripLeadingRouteSlash(token: string): string {
  let out = token;
  while (out.startsWith("/")) {
    out = out.slice(1);
  }
  return out;
}

function isAsciiUpper(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 65 && code <= 90;
}

function isAsciiLower(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 97 && code <= 122;
}

function isAsciiDigit(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function shouldSplitBefore(previous: string, current: string, next: string | undefined): boolean {
  if (!isAsciiUpper(current)) {
    return false;
  }
  if (isAsciiLower(previous) || isAsciiDigit(previous)) {
    return true;
  }
  return isAsciiUpper(previous) && next !== undefined && isAsciiLower(next);
}

function camelParts(token: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index] ?? "";
    if (current.length > 0 && shouldSplitBefore(token[index - 1] ?? "", char, token[index + 1])) {
      if (current.length >= 2) {
        parts.push(current);
      }
      current = char;
      continue;
    }
    current += char;
  }
  if (current.length >= 2) {
    parts.push(current);
  }
  return parts;
}

function addIdentifierDerivatives(
  out: string[],
  seen: Set<string>,
  token: string,
  caseSensitive: boolean,
): void {
  const strippedTest = stripTestIdentifierSuffix(token);
  if (strippedTest !== undefined) {
    addTerm(out, seen, strippedTest, caseSensitive);
  }
  for (const part of camelParts(token)) {
    addTerm(out, seen, part, caseSensitive);
  }
  if (strippedTest !== undefined) {
    for (const part of camelParts(strippedTest)) {
      addTerm(out, seen, part, caseSensitive);
    }
  }
}

function pluralYCandidate(lower: string, token: string): readonly string[] {
  return lower.length > 5 && lower.endsWith("ies") ? [`${token.slice(0, -3)}y`] : [];
}

function ingCandidates(lower: string, token: string): readonly string[] {
  if (lower.length <= 5 || !lower.endsWith("ing")) {
    return [];
  }
  const base = token.slice(0, -3);
  return [base, `${base}e`];
}

function edCandidates(lower: string, token: string): readonly string[] {
  if (lower.length <= 4 || !lower.endsWith("ed")) {
    return [];
  }
  const base = token.slice(0, -2);
  return [base, `${base}e`];
}

function esCandidate(lower: string, token: string): readonly string[] {
  return lower.length > 4 && lower.endsWith("es") ? [token.slice(0, -2)] : [];
}

function sCandidate(lower: string, token: string): readonly string[] {
  return lower.length > 3 && lower.endsWith("s") ? [token.slice(0, -1)] : [];
}

function morphologicalCandidates(token: string): readonly string[] {
  const lower = token.toLowerCase();
  return [
    ...pluralYCandidate(lower, token),
    ...ingCandidates(lower, token),
    ...edCandidates(lower, token),
    ...esCandidate(lower, token),
    ...sCandidate(lower, token),
  ];
}

function addMorphologicalDerivatives(
  out: string[],
  seen: Set<string>,
  token: string,
  caseSensitive: boolean,
): void {
  for (const candidate of morphologicalCandidates(token)) {
    addTerm(out, seen, candidate, caseSensitive);
    addDomainAliases(out, seen, candidate, caseSensitive);
  }
}

function addDomainAliases(
  out: string[],
  seen: Set<string>,
  token: string,
  caseSensitive: boolean,
): void {
  const aliases = DOMAIN_ALIASES.get(token.toLowerCase());
  if (aliases === undefined) {
    return;
  }
  for (const alias of aliases) {
    addTerm(out, seen, alias, caseSensitive);
  }
}

function expandToken(
  out: string[],
  seen: Set<string>,
  rawToken: string,
  caseSensitive: boolean,
): void {
  const token = stripStackLocationSuffix(rawToken);
  addTerm(out, seen, token, caseSensitive);
  addDomainAliases(out, seen, token, caseSensitive);
  if (ATOMIC_DOCUMENT_REFERENCE_RE.test(token)) {
    return;
  }
  if (token.startsWith("/")) {
    addTerm(out, seen, stripLeadingRouteSlash(token), caseSensitive);
  }
  addIdentifierDerivatives(out, seen, token, caseSensitive);
  const segments = token.split(TOKEN_SEPARATOR_RE).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    addTerm(out, seen, segment, caseSensitive);
    addDomainAliases(out, seen, segment, caseSensitive);
    addMorphologicalDerivatives(out, seen, segment, caseSensitive);
    addIdentifierDerivatives(out, seen, segment, caseSensitive);
  }
}

export function expandedQueryTerms(queryText: string, caseSensitive: boolean): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const singleCharacterFallbacks: string[] = [];
  for (const match of queryText.matchAll(QUERY_TOKEN_RE)) {
    if (match[0].length === 1) {
      singleCharacterFallbacks.push(match[0]);
    }
    expandToken(out, seen, match[0], caseSensitive);
    if (out.length >= MAX_EXPANDED_QUERY_TERMS) {
      break;
    }
  }
  if (out.length === 0) {
    for (const token of singleCharacterFallbacks) {
      addTerm(out, seen, token, caseSensitive, 1);
    }
  }
  return out;
}

interface GroupAppendResult {
  readonly total: number;
  readonly shouldStop: boolean;
}

function expandTokenGroup(rawToken: string, caseSensitive: boolean): string[] {
  const group: string[] = [];
  expandToken(group, new Set<string>(), rawToken, caseSensitive);
  return group;
}

function appendExpandedGroup(
  groups: string[][],
  group: readonly string[],
  total: number,
): GroupAppendResult {
  if (group.length === 0) {
    return { total, shouldStop: total >= MAX_EXPANDED_QUERY_TERMS };
  }
  const remaining = MAX_EXPANDED_QUERY_TERMS - total;
  if (remaining <= 0) {
    return { total, shouldStop: true };
  }
  const capped = group.slice(0, remaining);
  groups.push(capped);
  const nextTotal = total + capped.length;
  return { total: nextTotal, shouldStop: nextTotal >= MAX_EXPANDED_QUERY_TERMS };
}

function buildSingleCharacterGroups(tokens: readonly string[], caseSensitive: boolean): string[][] {
  const groups: string[][] = [];
  for (const token of tokens) {
    const group: string[] = [];
    addTerm(group, new Set<string>(), token, caseSensitive, 1);
    if (group.length > 0) {
      groups.push(group);
    }
  }
  return groups;
}

function* naturalLanguageGroupTokens(queryText: string): Generator<string> {
  for (const match of queryText.matchAll(QUERY_TOKEN_RE)) {
    const token = match[0];
    // Separate words are independent evidence, not interchangeable aliases. Keep known
    // domain aliases and numbered/path identifiers on their existing expansion path.
    if (
      /^\p{L}[\p{L}\p{M}]*(?:-\p{L}[\p{L}\p{M}]*)+$/u.test(token) &&
      !DOMAIN_ALIASES.has(token.toLowerCase())
    ) {
      yield* token.split("-");
    } else {
      yield token;
    }
  }
}

export function expandedQueryTermGroups(
  queryText: string,
  caseSensitive: boolean,
): readonly (readonly string[])[] {
  const groups: string[][] = [];
  const singleCharacterFallbacks: string[] = [];
  let total = 0;
  for (const token of naturalLanguageGroupTokens(queryText)) {
    if (token.length === 1) {
      singleCharacterFallbacks.push(token);
    }
    const group = expandTokenGroup(token, caseSensitive);
    const result = appendExpandedGroup(groups, group, total);
    total = result.total;
    if (result.shouldStop) {
      break;
    }
  }
  if (groups.length === 0) {
    return buildSingleCharacterGroups(singleCharacterFallbacks, caseSensitive);
  }
  return groups;
}
