export const LEXICAL_ANALYZER_KEY = "keiko-multilingual-bm25-analyzer-v2" as const;

export interface LexicalQueryTermGroup {
  readonly terms: readonly string[];
}

export interface LexicalAnalysis {
  readonly tokens: readonly string[];
  readonly indexTerms: readonly string[];
  readonly exactTerms: readonly string[];
}

const TOKEN_PATTERN = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}_./:#-]*[\p{L}\p{N}])?/gu;
const CJK_OR_KANA_OR_HANGUL_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_PATTERN = /\p{Script=Latin}/u;
const LETTER_PATTERN = /\p{L}/u;
const DIGIT_PATTERN = /\p{N}/u;
const EXACT_EDGE_PUNCTUATION_PATTERN = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const EXACT_SYMBOL_PATTERN = /[._:/#-]/u;
const CAMEL_CASE_PATTERN = /[a-z][A-Z]/u;

const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "aber",
  "about",
  "als",
  "am",
  "an",
  "and",
  "are",
  "as",
  "auf",
  "aus",
  "bei",
  "by",
  "das",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "ein",
  "eine",
  "einen",
  "einer",
  "eines",
  "for",
  "from",
  "fuer",
  "für",
  "how",
  "im",
  "in",
  "into",
  "is",
  "ist",
  "mit",
  "of",
  "on",
  "oder",
  "sagen",
  "steht",
  "the",
  "to",
  "und",
  "vom",
  "von",
  "was",
  "what",
  "wie",
  "zu",
  "zum",
  "zur",
]);

function unique(values: Iterable<string>): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function normaliseLexicalTerm(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}

function rawTokens(value: string): readonly string[] {
  return [...value.matchAll(TOKEN_PATTERN)].map((match) => normaliseLexicalTerm(match[0]));
}

function isIdentifierLike(token: string): boolean {
  return EXACT_SYMBOL_PATTERN.test(token) || CAMEL_CASE_PATTERN.test(token);
}

function isSearchStopword(token: string): boolean {
  return SEARCH_STOPWORDS.has(token);
}

function keepSearchToken(token: string): boolean {
  if (token.length === 0 || isSearchStopword(token)) return false;
  if (CJK_OR_KANA_OR_HANGUL_PATTERN.test(token)) return true;
  return token.length >= 2;
}

function multilingualSubtokens(token: string): readonly string[] {
  if (!CJK_OR_KANA_OR_HANGUL_PATTERN.test(token)) return [token];
  const chars = Array.from(token);
  const out = new Set<string>([token, ...chars]);
  for (let i = 0; i < chars.length - 1; i += 1) {
    out.add(`${chars[i] ?? ""}${chars[i + 1] ?? ""}`);
  }
  return [...out].filter((term) => term.length > 0);
}

function germanSpellingVariants(token: string): readonly string[] {
  const out = new Set<string>([token]);
  const umlautToAscii = token
    .replace(/ä/gu, "ae")
    .replace(/ö/gu, "oe")
    .replace(/ü/gu, "ue")
    .replace(/ß/gu, "ss");
  out.add(umlautToAscii);
  const asciiToUmlaut = token.replace(/ae/gu, "ä").replace(/oe/gu, "ö").replace(/ue/gu, "ü");
  out.add(asciiToUmlaut);
  if (token.includes("ss")) out.add(token.replace(/ss/gu, "ß"));
  return [...out].filter((term) => term.length > 0);
}

function deUmlautStemVariant(token: string): string {
  return token.replace(/äu/gu, "au").replace(/ä/gu, "a").replace(/ö/gu, "o").replace(/ü/gu, "u");
}

function addSuffixStem(out: Set<string>, token: string, suffix: string, replacement = ""): void {
  if (!token.endsWith(suffix)) return;
  const stem = `${token.slice(0, -suffix.length)}${replacement}`;
  if (stem.length >= 4) out.add(stem);
}

function germanStemCandidates(token: string): readonly string[] {
  if (!LATIN_PATTERN.test(token) || isIdentifierLike(token) || DIGIT_PATTERN.test(token)) {
    return [token];
  }
  const out = new Set<string>([token]);
  addSuffixStem(out, token, "ungen", "ung");
  addSuffixStem(out, token, "innen", "in");
  addSuffixStem(out, token, "heiten", "heit");
  addSuffixStem(out, token, "keiten", "keit");
  addSuffixStem(out, token, "chen");
  addSuffixStem(out, token, "lein");
  addSuffixStem(out, token, "ern");
  addSuffixStem(out, token, "en");
  addSuffixStem(out, token, "n");
  addSuffixStem(out, token, "er");
  addSuffixStem(out, token, "em");
  addSuffixStem(out, token, "es");
  addSuffixStem(out, token, "e");
  addSuffixStem(out, token, "s");
  for (const candidate of [...out]) {
    if (candidate === token) continue;
    const deUmlauted = deUmlautStemVariant(candidate);
    if (deUmlauted !== candidate && deUmlauted.length >= 4) out.add(deUmlauted);
  }
  return [...out];
}

function tokenIndexTerms(token: string, mode: "index" | "query"): readonly string[] {
  const surfaces = mode === "query" ? germanSpellingVariants(token) : [token];
  const terms = new Set<string>();
  for (const surface of surfaces) {
    for (const subtoken of multilingualSubtokens(surface)) {
      if (!keepSearchToken(subtoken)) continue;
      terms.add(subtoken);
      for (const stem of germanStemCandidates(subtoken)) {
        if (keepSearchToken(stem)) terms.add(stem);
      }
    }
  }
  return [...terms];
}

function indexTermsForText(value: string): readonly string[] {
  return unique(rawTokens(value).flatMap((token) => tokenIndexTerms(token, "index")));
}

export function lexicalTextTokens(value: string): readonly string[] {
  return unique(rawTokens(value).filter(keepSearchToken));
}

function trimExactCandidate(value: string): string {
  return value.normalize("NFC").replace(EXACT_EDGE_PUNCTUATION_PATTERN, "");
}

function isExactTerm(value: string): boolean {
  if (value.length < 2) return false;
  if (DIGIT_PATTERN.test(value)) return true;
  if (EXACT_SYMBOL_PATTERN.test(value)) return true;
  if (CAMEL_CASE_PATTERN.test(value)) return true;
  return (
    value.length >= 3 && value === value.toLocaleUpperCase("und") && LETTER_PATTERN.test(value)
  );
}

export function lexicalExactTerms(value: string): readonly string[] {
  const terms: string[] = [];
  for (const raw of value.split(/\s+/u)) {
    const candidate = trimExactCandidate(raw);
    if (!isExactTerm(candidate)) continue;
    terms.push(normaliseLexicalTerm(candidate));
  }
  return unique(terms);
}

export function analyzeLexicalText(value: string): LexicalAnalysis {
  const tokens = lexicalTextTokens(value);
  const indexTerms = indexTermsForText(value);
  const exactTerms = lexicalExactTerms(value);
  return { tokens, indexTerms, exactTerms };
}

export function lexicalQueryTermGroups(terms: readonly string[]): readonly LexicalQueryTermGroup[] {
  const groups: LexicalQueryTermGroup[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const normalized = normaliseLexicalTerm(term);
    const alternatives = unique(tokenIndexTerms(normalized, "query"));
    if (alternatives.length === 0) continue;
    const key = alternatives.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ terms: alternatives });
  }
  return groups;
}

export function lexicalQueryTerms(terms: readonly string[]): readonly string[] {
  return unique(lexicalQueryTermGroups(terms).flatMap((group) => group.terms));
}

export function lexicalStemVariants(value: string): readonly string[] {
  const variants = new Set<string>();
  for (const token of rawTokens(value)) {
    for (const term of tokenIndexTerms(token, "index")) {
      if (term !== token) variants.add(term);
    }
  }
  return [...variants];
}

export function lexicalIndexedText(value: string): string {
  const analyzed = analyzeLexicalText(value);
  return unique([value, ...analyzed.indexTerms]).join("\n");
}

export function lexicalExactText(value: string): string {
  const exactTerms = lexicalExactTerms(value);
  return exactTerms.length === 0 ? value : unique([value, ...exactTerms]).join("\n");
}
