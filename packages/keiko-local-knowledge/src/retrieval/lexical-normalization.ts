const LEXICAL_TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu;
const GERMAN_STEM_SUFFIXES = [
  "innen",
  "ungen",
  "ung",
  "chen",
  "lein",
  "ern",
  "em",
  "er",
  "es",
  "en",
  "e",
  "n",
  "s",
] as const;

function normalizeToken(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}

export function germanLightStem(token: string): string {
  const normalized = normalizeToken(token);
  if (normalized.length < 5 || /[0-9_/-]/u.test(normalized)) return normalized;
  for (const suffix of GERMAN_STEM_SUFFIXES) {
    if (normalized.length - suffix.length < 4 || !normalized.endsWith(suffix)) continue;
    return normalized.slice(0, -suffix.length);
  }
  return normalized;
}

function lexicalTokens(value: string): readonly string[] {
  return [...value.matchAll(LEXICAL_TOKEN_PATTERN)].map((match) => normalizeToken(match[0]));
}

export function lexicalStemVariants(value: string): readonly string[] {
  const variants = new Set<string>();
  for (const token of lexicalTokens(value)) {
    const stem = germanLightStem(token);
    if (stem !== token && stem.length >= 3) variants.add(stem);
  }
  return [...variants];
}

export function lexicalIndexedText(value: string): string {
  const variants = lexicalStemVariants(value);
  return variants.length === 0 ? value : `${value}\n${variants.join(" ")}`;
}

export function lexicalQueryTerms(terms: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const term of terms) {
    const normalized = normalizeToken(term);
    const stem = germanLightStem(normalized);
    out.add(stem.length >= 3 ? stem : normalized);
  }
  return [...out];
}
