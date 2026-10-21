// Shared deterministic presentation grammar, relocated from the existing workflow planner.
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

export function skipPresentationWhitespace(source: string, start: number): number {
  let end = start;
  while (PRESENTATION_WHITESPACE_RE.test(source.charAt(end))) end += 1;
  return end;
}

export function presentationTokenEnd(
  source: string,
  start: number,
  pattern: RegExp,
): number | undefined {
  pattern.lastIndex = start;
  const match = pattern.exec(source);
  return match === null ? undefined : start + match[0].length;
}

export function spacedPresentationTokenEnd(
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

export function withoutQueryPresentationInstructions(source: string): string {
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

/** Output formatting cannot supply evidence about the requested source subject. */
export function withoutAnswerPresentationInstructions(source: string): string {
  return [keepAnswerEnd, briefAnswerEnd, germanBriefAnswerEnd].reduce(
    (remaining, matcher) => maskPresentationInstruction(remaining, matcher),
    source,
  );
}
