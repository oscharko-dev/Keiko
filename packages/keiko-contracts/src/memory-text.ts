// Language-aware words of a memory text, shared by capture and retrieval so a fact is read the same
// way when it is learned and when it is found. German and English; pure and deterministic.

// Word boundary uses a Unicode-aware non-word matcher: any character that is not a letter, digit,
// or underscore (in any script) becomes a separator. This is a fixed-length pattern with no
// alternation or backreferences — not ReDoS-prone.
const NON_WORD = /[^\p{L}\p{N}_]+/u;
const COMBINING_MARKS = /\p{M}+/gu;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "which",
  "with",
  "am",
  "auf",
  "aus",
  "bei",
  "bin",
  "das",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "du",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "er",
  "es",
  "fur",
  "fuer",
  "ich",
  "im",
  "in",
  "ist",
  "mit",
  "oder",
  "sind",
  "und",
  "vom",
  "von",
  "was",
  "welche",
  "welchem",
  "welchen",
  "welcher",
  "welches",
  "wie",
  "wir",
  "zu",
  "zum",
  "zur",
]);

export function normalizeMemoryText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replaceAll("ß", "ss")
    .toLocaleLowerCase("und");
}

function stemGermanLikeToken(token: string): string {
  if (token.length <= 5) return token;
  const suffixes = ["ungen", "ern", "en", "er", "es", "s"];
  for (const suffix of suffixes) {
    if (suffix === "s" && token.endsWith("ss")) continue;
    if (token.length - suffix.length >= 5 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenizeMemoryText(text: string): readonly string[] {
  if (text === "") return [];
  const split = normalizeMemoryText(text).split(NON_WORD);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of split) {
    if (piece === "") continue;
    if (STOPWORDS.has(piece)) continue;
    const normalized = stemGermanLikeToken(piece);
    if (normalized === "" || STOPWORDS.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const MIN_SHARED_PREFIX_CHARS = 4;
const MAX_INFLECTION_CHARS = 3;

// Two tokens are the same word only when one is a short inflection of the other: "Tabelle" reaches
// "Tabellen", and "Java" does not reach "JavaScript".
export function sameMemoryWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return (
    shorter.length >= MIN_SHARED_PREFIX_CHARS &&
    longer.length - shorter.length <= MAX_INFLECTION_CHARS &&
    longer.startsWith(shorter)
  );
}
