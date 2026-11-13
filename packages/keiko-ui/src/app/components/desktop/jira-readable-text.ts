/**
 * Jira description and comment text as a person reads it (#4355). A model, and the canonical Data
 * Center projection of a Markdown description, write Jira wiki markup (`h2. Goal`, `*bold*`,
 * `{code}` fences, `|cells|`); shown verbatim it reads as raw markup.
 *
 * This is a display projection and nothing else. The rule that keeps it honest for an approval:
 * it removes markup tokens only. Whatever it does not recognise as markup by its position (a lone
 * `{color}`, `[ok|fail]` in prose, `-struck-` text, `!image!`, `[~user]`, an unknown macro, an
 * unclosed `*`) stays exactly as written, so no word of the source disappears and no strikethrough
 * or link target is shown as ordinary text. A link keeps its target beside its label. The scan is
 * linear: a closer that is not found once is not searched for again.
 */

const HEADING = /^h[1-6]\.[ \t]+/u;
const RULE = /^-{4,}[ \t]*$/u;
const BULLET = /^(\*+)[ \t]+(?=\S)/u;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/u;
const CODE_FENCE = /^[ \t]*\{(code|noformat)(?::[^}]*)?\}[ \t]*$/u;
const PANEL_FENCE = /^[ \t]*\{panel(?::([^}]*))?\}[ \t]*$/u;
const QUOTE_FENCE = /^[ \t]*\{quote\}[ \t]*$/u;
const COLOR_OPEN = /^\{color(?::[^}\n]*)?\}/u;
const LINK_TARGET = /^(?:https?:\/\/|mailto:)\S+$/iu;
const WORD = /[\p{L}\p{N}_]/u;
const ESCAPABLE = "{}[]~!|*_+-^?#\\";
const EMPTY_CELL = "–";
const NESTING_MAX = 3;

function isWord(character: string | undefined): boolean {
  return character !== undefined && WORD.test(character);
}
function isSpace(character: string | undefined): boolean {
  return character === undefined || /\s/u.test(character);
}

/** Where a `*bold*` or `_italic_` span closes, or -1; a miss means no later opener can close. */
function closerOf(line: string, marker: string, from: number): number {
  for (let at = from; at < line.length; at += 1) {
    if (line[at] !== marker || isSpace(line[at - 1])) continue;
    const after = line[at + 1];
    if (after === undefined || (!isWord(after) && after !== marker)) return at;
  }
  return -1;
}
function opensSpan(line: string, at: number): boolean {
  const before = line[at - 1];
  const after = line[at + 1];
  return !isWord(before) && before !== line[at] && !isSpace(after) && after !== line[at];
}

interface Scan {
  readonly line: string;
  readonly depth: number;
  at: number;
  readonly out: string[];
  /** Markers whose closer was searched for and not found: no later opener can find one. */
  readonly exhausted: Set<string>;
  closeBracket: number;
  openBracket: number;
}

/** The `]` that could close a link opened at `scan.at`; none when another `[` comes first. */
function linkClose(scan: Scan): number | undefined {
  const { line, at } = scan;
  if (scan.closeBracket < at) {
    const found = line.indexOf("]", at);
    scan.closeBracket = found < 0 ? Number.POSITIVE_INFINITY : found;
  }
  if (scan.openBracket <= at) {
    const next = line.indexOf("[", at + 1);
    scan.openBracket = next < 0 ? line.length : next;
  }
  const close = scan.closeBracket;
  return close === Number.POSITIVE_INFINITY || scan.openBracket < close ? undefined : close;
}

/** `[label|url]` or `[url]` with a web or mail target; anything else is prose. */
function linkText(inner: string): string | undefined {
  const bar = inner.indexOf("|");
  const target = bar < 0 ? inner : inner.slice(bar + 1);
  if (!LINK_TARGET.test(target)) return undefined;
  if (bar < 0) return target;
  const label = inner.slice(0, bar);
  return label.trim().length === 0 ? undefined : `${label} (${target})`;
}

function link(scan: Scan): boolean {
  const close = linkClose(scan);
  if (close === undefined) return false;
  const shown = linkText(scan.line.slice(scan.at + 1, close));
  if (shown === undefined) return false;
  scan.out.push(shown);
  scan.at = close + 1;
  return true;
}

function monospace(scan: Scan): boolean {
  const { line, at } = scan;
  if (!line.startsWith("{{", at) || scan.exhausted.has("{{")) return false;
  const close = line.indexOf("}}", at + 2);
  if (close < 0) {
    scan.exhausted.add("{{");
    return false;
  }
  scan.out.push(unescaped(line.slice(at + 2, close)));
  scan.at = close + 2;
  return true;
}

function color(scan: Scan): boolean {
  const { line, at } = scan;
  const open = COLOR_OPEN.exec(line.slice(at, at + 64));
  if (open === null || scan.exhausted.has("{color}")) return false;
  const close = line.indexOf("{color}", at + open[0].length);
  if (close < 0) {
    scan.exhausted.add("{color}");
    return false;
  }
  scan.out.push(inline(line.slice(at + open[0].length, close), scan.depth + 1));
  scan.at = close + "{color}".length;
  return true;
}

function emphasis(scan: Scan, marker: string): boolean {
  const { line, at } = scan;
  if (scan.exhausted.has(marker) || !opensSpan(line, at) || scan.depth >= NESTING_MAX) return false;
  const close = closerOf(line, marker, at + 2);
  if (close < 0) {
    scan.exhausted.add(marker);
    return false;
  }
  scan.out.push(inline(line.slice(at + 1, close), scan.depth + 1));
  scan.at = close + 1;
  return true;
}

function escape(scan: Scan): boolean {
  const next = scan.line[scan.at + 1];
  if (scan.line[scan.at] !== "\\" || next === undefined || !ESCAPABLE.includes(next)) return false;
  scan.out.push(next);
  scan.at += 2;
  return true;
}

function markup(scan: Scan): boolean {
  switch (scan.line[scan.at]) {
    case "\\":
      return escape(scan);
    case "[":
      return link(scan);
    case "{":
      return monospace(scan) || color(scan);
    case "*":
      return emphasis(scan, "*");
    case "_":
      return emphasis(scan, "_");
    default:
      return false;
  }
}

/** Recognised inline markup removed; everything else, character for character, kept. */
function inline(line: string, depth = 0): string {
  const scan: Scan = {
    line,
    depth,
    at: 0,
    out: [],
    exhausted: new Set(),
    closeBracket: -1,
    openBracket: -1,
  };
  while (scan.at < line.length) {
    if (markup(scan)) continue;
    scan.out.push(line.charAt(scan.at));
    scan.at += 1;
  }
  return scan.out.join("");
}

/** A backslash that escapes a markup character is itself markup; inside a monospace span too. */
function unescaped(text: string): string {
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const next = text[at + 1];
    if (text[at] === "\\" && next !== undefined && ESCAPABLE.includes(next)) {
      out += next;
      at += 1;
    } else out += text.charAt(at);
  }
  return out;
}

/** Cell texts split at the delimiter outside `[...]` and not escaped; a blank cell stays a cell. */
function splitCells(inner: string, delimiter: string): readonly string[] {
  const cells: string[] = [];
  let cell = "";
  let bracket = false;
  for (let at = 0; at < inner.length; at += 1) {
    const character = inner.charAt(at);
    if (character === "\\" && at + 1 < inner.length) {
      cell += character + inner.charAt(at + 1);
      at += 1;
    } else if (!bracket && inner.startsWith(delimiter, at)) {
      cells.push(cell);
      cell = "";
      at += delimiter.length - 1;
    } else {
      bracket = character === "[" || (bracket && character !== "]");
      cell += character;
    }
  }
  return [...cells, cell];
}

function tableCells(row: string): string {
  const trimmed = row.trim();
  const header = trimmed.startsWith("||");
  const end = trimmed.length - (header && trimmed.endsWith("||") ? 2 : 1);
  return splitCells(trimmed.slice(header ? 2 : 1, end), header ? "||" : "|")
    .map((entry) => (entry.trim() === "" ? EMPTY_CELL : inline(entry.trim())))
    .join(" · ");
}

interface Block {
  fence: string | undefined;
}

function listLine(line: string): string | undefined {
  const bullet = BULLET.exec(line);
  return bullet === null
    ? undefined
    : `${"  ".repeat((bullet[1] ?? "*").length - 1)}• ${inline(line.slice(bullet[0].length))}`;
}

/** A panel fence is markup; its title, when it has one, is text. */
function panelLine(parameters: string | undefined): string | null {
  const title = /(?:^|\|)title=([^|]*)/u.exec(parameters ?? "")?.[1]?.trim() ?? "";
  return title === "" ? null : inline(title);
}

/** A fence line carries only markup (a panel's title stays as text); content lines are kept. */
function fenceLine(block: Block, line: string): string | undefined | null {
  const code = CODE_FENCE.exec(line);
  if (block.fence !== undefined) {
    if (code?.[1] !== block.fence) return line;
    block.fence = undefined;
    return null;
  }
  const panel = PANEL_FENCE.exec(line);
  if (code === null && panel === null) return QUOTE_FENCE.test(line) ? null : undefined;
  block.fence = code?.[1];
  return panel === null ? null : panelLine(panel[1]);
}

function readableLine(block: Block, line: string): string | undefined {
  const fenced = fenceLine(block, line);
  if (fenced === null) return undefined;
  if (fenced !== undefined) return fenced;
  if (RULE.test(line)) return "";
  if (HEADING.test(line)) return inline(line.replace(HEADING, ""));
  if (TABLE_ROW.test(line)) return tableCells(line);
  return listLine(line) ?? inline(line);
}

export function jiraReadableText(text: string): string {
  const block: Block = { fence: undefined };
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const readable = readableLine(block, line);
    if (readable !== undefined) lines.push(readable);
  }
  return lines.join("\n");
}
