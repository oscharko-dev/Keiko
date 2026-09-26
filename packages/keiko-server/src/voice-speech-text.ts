// The trailing "decoration" after the keyword -- whitespace, an optional colon, optional bold
// (`**`/`__`) markers, in any order and of any length -- is matched with a single non-backtracking
// character class run instead of two independently optional `\s*` runs sandwiching a
// `:?(?:\*\*|__)?` group. That two-`\s*` shape is the textbook super-linear-backtracking pattern
// (S8786): when the middle group is absent, the two `\s*` runs collapse into one string with an
// ambiguous partition point, and a failing match backtracks through every partition in O(n^2).
// Bounding each `\s*` to a fixed count (an earlier fix attempt) "solves" the backtracking but
// silently stops recognizing any heading whose trailing padding exceeds the bound -- and this
// heading match is a security-relevant suppression boundary (see `toSpeakableText`: everything
// after a recognized heading line is dropped from speech), so an unrecognized heading lets an
// entire citation/source appendix leak into synthesized speech. Folding whitespace/colon/marker
// into one `[\s:*_]*` quantifier removes the backtracking ambiguity entirely -- a single
// quantifier's match has only one possible partition -- so it is simultaneously O(n) *and* correct
// for a heading line with an arbitrarily long (unbounded) trailing decoration.
const SOURCE_HEADING =
  /^\s{0,3}(?:#{1,6}\s+|\*\*|__)?(?:sources|references|citations|quellen|belege|nachweise)[\s:*_]*$/iu;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\([^\n)]*\)/gu;
const AUTOLINK_URL = /<https?:\/\/[^\s<>]+>/giu;
const BARE_URL = /https?:\/\/[^\s<>]+/giu;
const REFERENCE_DEFINITION = /^\s*\[(?:\^?\d+|[^\]]+)\]:\s+/u;

function isAsciiDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isAsciiLetter(character: string): boolean {
  return (character >= "A" && character <= "Z") || (character >= "a" && character <= "z");
}

// Consumes a run of one-or-more characters satisfying `test`, starting at `start`. Returns the
// index just past the run, or `start` unchanged when no character matched (a zero-length run).
function consumeRun(text: string, start: number, test: (character: string) => boolean): number {
  let index = start;
  while (index < text.length && test(text[index] ?? "")) index += 1;
  return index;
}

// The citation-marker body grammar (former CITATION_MARKER regex, now a manual scanner -- see
// stripCitationMarkers below for why): `\^?\d+` (a footnote number, optionally caret-prefixed) or
// `[A-Za-z]+-?\d+` (a letter label, optionally hyphenated, followed by mandatory digits). Returns
// the index just past the matched body, or undefined when `start` does not open either shape.
function citationMarkerBodyEnd(text: string, start: number): number | undefined {
  const first = text[start];
  if (first === undefined) return undefined;
  if (first === "^" || isAsciiDigit(first)) {
    const digitsStart = first === "^" ? start + 1 : start;
    const digitsEnd = consumeRun(text, digitsStart, isAsciiDigit);
    return digitsEnd > digitsStart ? digitsEnd : undefined;
  }
  if (isAsciiLetter(first)) {
    const lettersEnd = consumeRun(text, start, isAsciiLetter);
    const afterHyphen = text[lettersEnd] === "-" ? lettersEnd + 1 : lettersEnd;
    const digitsEnd = consumeRun(text, afterHyphen, isAsciiDigit);
    return digitsEnd > afterHyphen ? digitsEnd : undefined;
  }
  return undefined;
}

// Returns the index just past the closing `]` of a citation marker opening at `text[open] ===
// "["`, or undefined when `open` does not open one.
function citationMarkerEnd(text: string, open: number): number | undefined {
  const bodyEnd = citationMarkerBodyEnd(text, open + 1);
  return bodyEnd !== undefined && text[bodyEnd] === "]" ? bodyEnd + 1 : undefined;
}

/**
 * Removes every citation marker (`[1]`, `[^12]`, `[A-1]`, ...) from `text`, in one linear
 * left-to-right pass. Deliberately not the former bounded regex
 * (`/\s{0,20}\[(?:\^?\d{1,100}|[A-Za-z]{1,100}-?\d{1,100})\]/gu`): that bound kept the match O(n)
 * but silently stopped RECOGNIZING (and thus stripping) any marker whose digit run or letter label
 * exceeded 100 characters, leaving the raw bracketed marker to be spoken aloud verbatim -- a
 * regression of the exact suppression guarantee this module exists to enforce (a citation marker
 * must never reach TTS, regardless of length). This scanner has no such bound: `citationMarkerEnd`
 * fails fast in O(1) on a `[` whose very next character cannot start either shape (unlike the
 * markdown-link scanner below, which must search ahead for a terminator because a link label is
 * shape-unconstrained), and every character `consumeRun` DOES scan is consumed by the enclosing
 * `cursor`, so no character is ever rescanned by a later attempt from an earlier offset -- the same
 * amortized-O(n) argument `stripMarkdownLinks` relies on, without needing its bounded window.
 */
function stripCitationMarkers(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("[", cursor);
    if (open < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, open));
    const end = citationMarkerEnd(text, open);
    if (end === undefined) {
      parts.push("[");
      cursor = open + 1;
      continue;
    }
    cursor = end;
  }
  return parts.join("");
}

function isTagBoundary(value: string | undefined): boolean {
  return value === undefined || value === ">" || value === "/" || value.trim().length === 0;
}

function rawElementStart(lowerText: string, tagName: string, from: number): number {
  let cursor = from;
  while (cursor < lowerText.length) {
    const start = lowerText.indexOf(`<${tagName}`, cursor);
    if (start < 0) return -1;
    if (isTagBoundary(lowerText[start + tagName.length + 1])) return start;
    cursor = start + 1;
  }
  return -1;
}

function stripRawElement(text: string, tagName: "script" | "style"): string {
  const lowerText = text.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = rawElementStart(lowerText, tagName, cursor);
    if (start < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const close = lowerText.indexOf(`</${tagName}`, start + tagName.length + 1);
    if (close < 0) break;
    const closeEnd = text.indexOf(">", close + tagName.length + 2);
    if (closeEnd < 0) break;
    cursor = closeEnd + 1;
  }
  return parts.join("");
}

function stripHtml(text: string): string {
  const withoutRawContent = stripRawElement(stripRawElement(text, "script"), "style");
  const parts: string[] = [];
  let inTag = false;
  for (const character of withoutRawContent) {
    if (character === "<") inTag = true;
    else if (character === ">") inTag = false;
    else if (!inTag) parts.push(character);
  }
  return parts.join("");
}

// Bounding the search window keeps every scan O(1) instead of O(remaining text), which is
// what made the previous regex (`\[([^\]\n]+)\]\([^\n)]*\)`) quadratic on many-`[`-with-no-`]`
// adversarial input. Widened to 8000 (KEIKO-0473 / GEN-VOICE-DICTATION-TTS-002): real
// presigned or query-string-bearing citation URLs can exceed 2000 chars, and the previous
// window silently gave up mid-link, leaking stray `[`, `]`, and `(` into synthesized speech.
const MAX_MARKDOWN_LINK_SPAN = 8000;

type MarkdownLinkMatch =
  | { readonly kind: "match"; readonly label: string; readonly end: number }
  | { readonly kind: "giveUp" }
  | { readonly kind: "none" };

// Returns the absolute index of `needle` found within `MAX_MARKDOWN_LINK_SPAN` characters of
// `from`, `-1` if `needle` is confirmed absent for the remainder of `text` (the scan window
// reached the end of the string empty-handed, so no later start position can find it either),
// or `-2` if it was merely not found within the bounded window (inconclusive).
function scanBoundedFrom(text: string, from: number, needle: string): number {
  const windowEnd = Math.min(text.length, from + MAX_MARKDOWN_LINK_SPAN);
  const relative = text.slice(from, windowEnd).indexOf(needle);
  if (relative >= 0) return from + relative;
  return windowEnd === text.length ? -1 : -2;
}

function matchMarkdownLinkAt(text: string, open: number): MarkdownLinkMatch {
  const bracketClose = scanBoundedFrom(text, open + 1, "]");
  if (bracketClose === -1) return { kind: "giveUp" };
  if (bracketClose < 0 || bracketClose === open + 1) return { kind: "none" };
  if (text[bracketClose + 1] !== "(" || text.slice(open + 1, bracketClose).includes("\n")) {
    return { kind: "none" };
  }
  const urlStart = bracketClose + 2;
  const parenClose = scanBoundedFrom(text, urlStart, ")");
  if (parenClose === -1) return { kind: "giveUp" };
  if (parenClose < 0 || text.slice(urlStart, parenClose).includes("\n")) return { kind: "none" };
  return { kind: "match", label: text.slice(open + 1, bracketClose), end: parenClose + 1 };
}

/**
 * Replaces `[label](url)` markdown links with their label, in one linear left-to-right pass.
 * Deliberately not a single backtracking regex: the previous `/\[([^\]\n]+)\]\([^\n)]*\)/gu`
 * re-attempted the same unbounded scan at every candidate `[`, which is O(n^2) on adversarial
 * input such as a long run of unmatched `[` characters (confirmed empirically before this fix).
 */
function stripMarkdownLinks(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("[", cursor);
    if (open < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, open));
    const result = matchMarkdownLinkAt(text, open);
    if (result.kind === "giveUp") {
      parts.push(text.slice(open));
      break;
    }
    if (result.kind === "none") {
      parts.push("[");
      cursor = open + 1;
      continue;
    }
    parts.push(result.label);
    cursor = result.end;
  }
  return parts.join("");
}

function stripMarkdown(line: string): string {
  const withoutMarkdown = stripCitationMarkers(
    stripMarkdownLinks(line.replace(MARKDOWN_IMAGE, ""))
      .replace(AUTOLINK_URL, "")
      .replace(BARE_URL, ""),
  )
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "");
  return stripHtml(withoutMarkdown).replace(/[*_~]+/gu, "");
}

// Bounded to 20 whitespace characters: a lone `\s+` immediately followed by a required literal
// class is, on its own, an unbounded quantifier that a global match retries at every offset of
// a long non-matching whitespace run, which is confirmed O(n^2) (see .test.ts). In this file the
// preceding `\s+` -> " " collapse (below) already limits real input to single-space runs, but the
// pattern is exported standalone so the fix itself — not just its current caller — is regression
// tested.
const SPACE_BEFORE_PUNCTUATION = /\s{1,20}([,.;:!?])/gu;

/** Exported for direct regression testing of the punctuation-spacing regex (see .test.ts). */
export function stripSpaceBeforePunctuation(text: string): string {
  return text.replace(SPACE_BEFORE_PUNCTUATION, "$1");
}

function normalizeProse(text: string): string {
  return text
    .replace(/\(\s*\)|\[\s*\]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(SPACE_BEFORE_PUNCTUATION, "$1")
    .replace(/([:;,])\s*([.!?])/gu, "$2")
    .trim();
}

function speakableLine(line: string): string | undefined {
  if (REFERENCE_DEFINITION.test(line)) return undefined;
  const heading = /^\s{0,3}#{1,6}\s+/u.test(line);
  const prose = normalizeProse(stripMarkdown(line));
  if (prose.length === 0) return undefined;
  return heading && !/[.!?]$/u.test(prose) ? `${prose}.` : prose;
}

/**
 * Produces a speech-only rendering of visible Markdown. The visible answer remains untouched for
 * review and clickable citations; URLs, citation syntax, source appendices, and fenced code never
 * reach synthesis or realtime response instructions.
 */
export function toSpeakableText(markdown: string): string {
  const parts: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (SOURCE_HEADING.test(line)) break;
    const part = speakableLine(line);
    if (part !== undefined) parts.push(part);
  }
  return normalizeProse(parts.join(" "));
}
