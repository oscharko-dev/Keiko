// Source descriptions identify requested evidence, never organizational approval or authority.
const SOURCE_ADVICE_ATTRIBUTION_RE =
  /(?<![\p{L}\p{M}\p{N}_])(?:according\s+to|as\s+(?:specified|documented)\s+in|based\s+on|laut|gemäß)(?![\p{L}\p{M}\p{N}_])/iu;
const DESCRIPTOR_ATTRIBUTION_RE = new RegExp(
  String.raw`${SOURCE_ADVICE_ATTRIBUTION_RE.source}|\b(?:following|using)\b`,
  "giu",
);
const SOURCE_ADVICE_NOUN_PATTERNS = [
  /^(?:sources?|manuals?|documents?|files?|folders?)$/iu,
  /^(?:repositor(?:y|ies)|evidence|codes?|implementations?)$/iu,
  /^(?:handbuch(?:e?s)?|handbüchern?|quellen?|datei(?:en)?|ordner[sn]?)$/iu,
  /^(?:dokument(?:e[sn]?|s)?|repositorys?|implementierung(?:en)?)$/iu,
];
const SOURCE_DESCRIPTOR_NOUN_PATTERNS = [
  ...SOURCE_ADVICE_NOUN_PATTERNS,
  /^(?:conventions?|guidelines?|standards?|requirements?|contracts?|polic(?:y|ies))$/iu,
  /^(?:specifications?|checklists?|procedures?|playbooks?|decisions?|guidance|instructions?|build)$/iu,
  /^(?:konventionen?|richtlinien?|anforderungen?|vorgaben?)$/iu,
];
const NEGATED_SOURCE_RE =
  /\b(?:no|not|never|without|neither|ignore|ignoring|nicht|keine?|keinen|keinem|keiner|ohne|ignorieren)\b/iu;
const DESCRIPTOR_WORD_RE = /[\p{L}\p{M}\p{N}_-]+/gu;
const DETERMINER_RE = /^(?:the|this|these|our|my|your|all|der|die|das|den|dem|des|alle|unsere?)$/iu;
const MAX_DESCRIPTOR_CHARACTERS = 4096;
const MAX_DESCRIPTOR_WORDS = 12;
const LIST_CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "und"]);

function* descriptorListItems(span: string): Generator<string> {
  let start = 0;
  let cursor = 0;
  while (cursor < span.length) {
    const comma = span.charAt(cursor) === ",";
    const conjunction =
      /\s/u.test(span.charAt(cursor - 1)) &&
      LIST_CONJUNCTIONS.has(span.slice(cursor, cursor + 3).toLowerCase()) &&
      /\s/u.test(span.charAt(cursor + 3));
    if (!comma && !conjunction) {
      cursor += 1;
      continue;
    }
    yield span.slice(start, cursor);
    start = cursor + (comma ? 1 : 3);
    cursor = start;
  }
  yield span.slice(start);
}

function descriptorWords(source: string, caseSensitive: boolean): readonly string[] {
  if (/[./:\\]/u.test(source)) return [];
  const normalized = source.normalize("NFC");
  const words =
    (caseSensitive ? normalized : normalized.toLowerCase()).match(DESCRIPTOR_WORD_RE) ?? [];
  let first = 0;
  while (first < words.length && DETERMINER_RE.test(words[first] ?? "")) first += 1;
  const content = words.slice(first);
  return content.length >= 2 &&
    content.length <= MAX_DESCRIPTOR_WORDS &&
    content.some((word) => SOURCE_DESCRIPTOR_NOUN_PATTERNS.some((pattern) => pattern.test(word)))
    ? content
    : [];
}

function* clauseDescriptorPhrases(clause: string): Generator<string> {
  const attributions = [...clause.matchAll(DESCRIPTOR_ATTRIBUTION_RE)];
  let end = clause.length;
  while (end > 0 && /[.!?;]/u.test(clause.charAt(end - 1))) end -= 1;
  for (let index = 0; index < attributions.length; index += 1) {
    const attribution = attributions[index];
    if (attribution === undefined) continue;
    const next = attributions[index + 1]?.index ?? end;
    // Disjoint spans: repeated attribution words never reparse overlapping suffixes.
    const span = clause.slice(attribution.index + attribution[0].length, next);
    yield* descriptorListItems(span);
  }
}

/** Preserve complete positive list items; ambiguous, quoted and oversized descriptions decline. */
export function querySourceDescriptors(
  text: string,
  caseSensitive = false,
): readonly (readonly string[])[] {
  if (/["'`“”‘’«»\0]/u.test(text)) return [];
  const descriptors: (readonly string[])[] = [];
  const seen = new Set<string>();
  let characters = 0;
  for (const clause of text.split(/(?<=[.!?;])\s+|\n+/u)) {
    if (NEGATED_SOURCE_RE.test(clause)) continue;
    for (const phrase of clauseDescriptorPhrases(clause)) {
      const words = descriptorWords(phrase.trim(), caseSensitive);
      if (words.length === 0) continue;
      const identity = words.join(" ");
      if (seen.has(identity)) continue;
      seen.add(identity);
      characters += identity.length;
      if (characters > MAX_DESCRIPTOR_CHARACTERS) return [];
      descriptors.push(words);
    }
  }
  return descriptors;
}

export function hasSourceAdviceAttribution(text: string): boolean {
  return SOURCE_ADVICE_ATTRIBUTION_RE.test(text) || querySourceDescriptors(text).length > 0;
}

export function isSourceAdviceNoun(token: string): boolean {
  return SOURCE_ADVICE_NOUN_PATTERNS.some((pattern) => pattern.test(token));
}

function orderedDescriptorMatch(line: string, expected: readonly string[]): boolean {
  let next = 0;
  let skipped = 0;
  let previousEnd = 0;
  for (const match of line.matchAll(DESCRIPTOR_WORD_RE)) {
    if (/[.;:!?]/u.test(line.slice(previousEnd, match.index)) || skipped > 2) next = 0;
    previousEnd = match.index + match[0].length;
    if (match[0] === expected[next]) {
      next += 1;
      skipped = 0;
      if (next === expected.length) return true;
    } else {
      skipped += 1;
      if (match[0] === expected[0]) {
        next = 1;
        skipped = 0;
      }
    }
  }
  return false;
}

/** A complete ordered whole-word witness must occur on one actually observed coherent line. */
export function matchesQuerySourceDescriptor(
  content: string,
  descriptors: readonly (readonly string[])[],
  caseSensitive = false,
): boolean {
  return content
    .split("\n")
    .some(
      (line) =>
        line.length <= MAX_DESCRIPTOR_CHARACTERS &&
        !NEGATED_SOURCE_RE.test(line) &&
        descriptors.some((descriptor) =>
          orderedDescriptorMatch(
            caseSensitive ? line.normalize("NFC") : line.normalize("NFC").toLowerCase(),
            descriptor,
          ),
        ),
    );
}
