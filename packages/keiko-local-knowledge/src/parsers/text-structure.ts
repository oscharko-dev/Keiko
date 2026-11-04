// Section structure of lightweight markup (#4235): the heading forms of Markdown, reStructuredText
// and AsciiDoc over one line model. Pure string scanning, one pass per concern, no backtracking
// regular expressions over whole documents.
//
// A line carries structure only while it is "live": text inside a code fence, an HTML comment, a
// front-matter block or a delimited listing block is content, never a heading or a table.

export type MarkupKind = "markdown" | "rst" | "asciidoc" | "plain";

export interface SourceLine {
  // The line without its line ending (`\n` or `\r\n`), so `\r` never reaches a section path.
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface Heading {
  readonly level: number;
  readonly text: string;
  readonly characterStart: number;
}

export function sourceLines(text: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const end = lineEnd > cursor && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    lines.push({ text: text.slice(cursor, end), start: cursor, end });
    cursor = lineEnd + 1;
  }
  return lines;
}

const SPACE = 0x20;
const TAB = 0x09;
const HASH = 0x23;
const MAX_INDENT = 3;

function isHSpace(code: number): boolean {
  return code === SPACE || code === TAB;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line.codePointAt(i) === SPACE) i += 1;
  return i;
}

// ─── Live lines ──────────────────────────────────────────────────────────────

interface Fence {
  readonly char: string;
  readonly length: number;
}

// A code fence opens with three or more backticks or tildes, indented at most three spaces; the info
// string of a backtick fence cannot contain a backtick.
function fenceOpening(line: string): Fence | undefined {
  const indent = indentOf(line);
  if (indent > MAX_INDENT) return undefined;
  const char = line[indent];
  if (char !== "`" && char !== "~") return undefined;
  let end = indent;
  while (line[end] === char) end += 1;
  const length = end - indent;
  if (length < 3) return undefined;
  if (char === "`" && line.slice(end).includes("`")) return undefined;
  return { char, length };
}

// The closing fence repeats the opening character at least as often and carries nothing else.
function closesFence(line: string, fence: Fence): boolean {
  const indent = indentOf(line);
  if (indent > MAX_INDENT) return false;
  let end = indent;
  while (line[end] === fence.char) end += 1;
  return end - indent >= fence.length && line.slice(end).trim().length === 0;
}

function frontMatterEnd(lines: readonly SourceLine[]): number {
  const first = lines[0]?.text.trimEnd();
  if (first !== "---" && first !== "+++") return -1;
  for (let i = 1; i < lines.length; i += 1) {
    const text = lines[i]?.text.trimEnd();
    if (text === first || (first === "---" && text === "...")) return i;
  }
  return -1;
}

interface BlockState {
  fence: Fence | undefined;
  comment: boolean;
}

// Whether the line is structure; advances the fence and comment state across it.
function markdownLineIsLive(state: BlockState, line: string): boolean {
  if (state.fence !== undefined) {
    if (closesFence(line, state.fence)) state.fence = undefined;
    return false;
  }
  if (state.comment) {
    state.comment = !line.includes("-->");
    return false;
  }
  const opening = fenceOpening(line);
  if (opening !== undefined) {
    state.fence = opening;
    return false;
  }
  const trimmed = line.trimStart();
  if (trimmed.startsWith("<!--")) {
    state.comment = !trimmed.includes("-->", 4);
    return false;
  }
  return true;
}

function markdownLiveness(lines: readonly SourceLine[]): boolean[] {
  const live = lines.map(() => true);
  const front = frontMatterEnd(lines);
  for (let i = 0; i <= front; i += 1) live[i] = false;
  const state: BlockState = { fence: undefined, comment: false };
  for (let i = front + 1; i < lines.length; i += 1) {
    live[i] = markdownLineIsLive(state, lines[i]?.text ?? "");
  }
  return live;
}

const ASCIIDOC_DELIMITER = /^(?:-{4,}|\.{4,}|\+{4,}|\/{4,})$/u;

// Listing, literal, passthrough and comment blocks end at their own delimiter line; a line comment
// (`// …`) is not structure either.
function asciidocLiveness(lines: readonly SourceLine[]): boolean[] {
  let open: string | undefined;
  return lines.map((line) => {
    const trimmed = line.text.trim();
    if (open !== undefined) {
      if (trimmed === open) open = undefined;
      return false;
    }
    if (ASCIIDOC_DELIMITER.test(trimmed)) {
      open = trimmed;
      return false;
    }
    return !(trimmed.startsWith("//") && !trimmed.startsWith("///"));
  });
}

export function liveLines(lines: readonly SourceLine[], kind: MarkupKind): readonly boolean[] {
  if (kind === "markdown") return markdownLiveness(lines);
  if (kind === "asciidoc") return asciidocLiveness(lines);
  return lines.map(() => true);
}

// ─── Markdown ────────────────────────────────────────────────────────────────

function countHashes(line: string, from: number): number {
  let i = from;
  while (i < line.length && line.codePointAt(i) === HASH && i - from < 7) i += 1;
  return i - from;
}

function trimHSpaceEnd(line: string, start: number, from: number): number {
  let end = from;
  while (end > start && isHSpace(line.codePointAt(end - 1) ?? 0)) end -= 1;
  return end;
}

// The closing sequence of an ATX heading is a run of `#` preceded by a space; `## C#` keeps its `#`.
function trimAtxTrailing(line: string, start: number): number {
  const end = trimHSpaceEnd(line, start, line.length);
  let run = end;
  while (run > start && line.codePointAt(run - 1) === HASH) run -= 1;
  const closing = run < end && (run === start || isHSpace(line.codePointAt(run - 1) ?? 0));
  return closing ? trimHSpaceEnd(line, start, run) : end;
}

function atxLevel(line: string): { readonly level: number; readonly textStart: number } | null {
  const indent = indentOf(line);
  if (indent > MAX_INDENT) return null;
  const level = countHashes(line, indent);
  const afterHashes = indent + level;
  if (level < 1 || level > 6 || !isHSpace(line.codePointAt(afterHashes) ?? 0)) return null;
  let textStart = afterHashes;
  while (textStart < line.length && isHSpace(line.codePointAt(textStart) ?? 0)) textStart += 1;
  return { level, textStart };
}

function matchAtxHeading(line: string): { readonly level: number; readonly text: string } | null {
  const head = atxLevel(line);
  if (head === null) return null;
  const textEnd = trimAtxTrailing(line, head.textStart);
  return textEnd <= head.textStart
    ? null
    : { level: head.level, text: line.slice(head.textStart, textEnd) };
}

function matchSetextUnderline(line: string): 1 | 2 | null {
  if (indentOf(line) > MAX_INDENT) return null;
  const trimmed = line.trim();
  if (/^=+$/u.test(trimmed)) return 1;
  return /^-{3,}$/u.test(trimmed) ? 2 : null;
}

export function splitMarkdownTableRow(line: string): readonly string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  return body.split("|").map((part) => part.trim());
}

export function isMarkdownTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/u;

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") || trimmed.endsWith("|") || isMarkdownTableSeparator(line);
}

// A paragraph line can be the text of a setext heading. A list item, table row, quote, indented code
// line or thematic break cannot: `---` after one of them is a rule, not an underline.
function isSetextCandidate(line: string): boolean {
  if (line.trim().length === 0 || indentOf(line) > MAX_INDENT) return false;
  if (LIST_ITEM.test(line) || looksLikeTableRow(line)) return false;
  const trimmed = line.trimStart();
  return !trimmed.startsWith(">") && matchSetextUnderline(line) === null;
}

export function scanMarkdownHeadings(
  lines: readonly SourceLine[],
  live: readonly boolean[],
): readonly Heading[] {
  const out: Heading[] = [];
  let pending: SourceLine | undefined;
  for (const [index, lineInfo] of lines.entries()) {
    if (live[index] !== true) {
      pending = undefined;
      continue;
    }
    const setext = matchSetextUnderline(lineInfo.text);
    if (setext !== null && pending !== undefined) {
      out.push({ level: setext, text: pending.text.trim(), characterStart: pending.start });
      pending = undefined;
      continue;
    }
    const atx = matchAtxHeading(lineInfo.text);
    if (atx !== null) out.push({ ...atx, characterStart: lineInfo.start });
    pending = atx === null && isSetextCandidate(lineInfo.text) ? lineInfo : undefined;
  }
  return out;
}

// ─── AsciiDoc ────────────────────────────────────────────────────────────────

export function scanAsciiDocHeadings(
  lines: readonly SourceLine[],
  live: readonly boolean[],
): readonly Heading[] {
  const out: Heading[] = [];
  for (const [index, line] of lines.entries()) {
    if (live[index] !== true) continue;
    const match = /^(={1,6})\s+(\S.*)$/u.exec(line.text);
    const marks = match?.[1];
    const title = match?.[2];
    if (marks === undefined || title === undefined) continue;
    out.push({ level: marks.length, text: title.trim(), characterStart: line.start });
  }
  return out;
}

// ─── reStructuredText ────────────────────────────────────────────────────────

const RST_ADORNMENT = /^([!-/:-@[-`{-~])\1+$/u;
const RST_MIN_ADORNMENT = 3;

function adornment(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const trimmed = line.trimEnd();
  return RST_ADORNMENT.test(trimmed) && trimmed.length >= RST_MIN_ADORNMENT ? trimmed : undefined;
}

function isRstTitle(line: string | undefined): line is string {
  return (
    line !== undefined &&
    line.trim().length > 0 &&
    indentOf(line) === 0 &&
    adornment(line) === undefined
  );
}

interface RstHeading {
  readonly style: string;
  readonly text: string;
  readonly first: number;
  readonly span: number;
}

function overlinedRstHeading(lines: readonly SourceLine[], index: number): RstHeading | undefined {
  const over = adornment(lines[index]?.text);
  const title = lines[index + 1]?.text;
  const under = adornment(lines[index + 2]?.text);
  if (over === undefined || under !== over || !isRstTitle(title)) return undefined;
  if (over.length < title.trimEnd().length) return undefined;
  return { style: `over${over[0] ?? ""}`, text: title.trim(), first: index, span: 3 };
}

function underlinedRstHeading(lines: readonly SourceLine[], index: number): RstHeading | undefined {
  const title = lines[index]?.text;
  const under = adornment(lines[index + 1]?.text);
  if (!isRstTitle(title) || under === undefined) return undefined;
  if (under.length < title.trimEnd().length) return undefined;
  return { style: `under${under[0] ?? ""}`, text: title.trim(), first: index, span: 2 };
}

// An underlined title, or one with an overline of the same character; the adornment must be at
// least as long as the title text. Titles share a section depth only when they share the style
// (overline or not, and the character).
function rstHeadingAt(lines: readonly SourceLine[], index: number): RstHeading | undefined {
  return overlinedRstHeading(lines, index) ?? underlinedRstHeading(lines, index);
}

export function scanRstHeadings(lines: readonly SourceLine[]): readonly Heading[] {
  const out: Heading[] = [];
  const levels = new Map<string, number>();
  let index = 0;
  while (index < lines.length) {
    const heading = rstHeadingAt(lines, index);
    if (heading === undefined) {
      index += 1;
      continue;
    }
    if (!levels.has(heading.style)) levels.set(heading.style, levels.size + 1);
    out.push({
      level: levels.get(heading.style) ?? 1,
      text: heading.text,
      characterStart: lines[heading.first]?.start ?? 0,
    });
    index += heading.span;
  }
  return out;
}

export function scanHeadings(
  lines: readonly SourceLine[],
  live: readonly boolean[],
  kind: MarkupKind,
): readonly Heading[] {
  if (kind === "markdown") return scanMarkdownHeadings(lines, live);
  if (kind === "asciidoc") return scanAsciiDocHeadings(lines, live);
  return kind === "rst" ? scanRstHeadings(lines) : [];
}
