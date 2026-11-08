/**
 * Markdown block and inline structure written as Jira Data Center wiki markup (#4173 AC2).
 *
 * Data Center renders wiki markup, so `**Goal**` arrives as literal asterisks, `[text](url)` as a
 * broken link and a fenced block as prose. Headings are serialized by the shared heading reader
 * first; this pass converts the rest: emphasis, inline code, links, lists, rules, tables and fenced
 * code. A quoted line keeps its `>`: quoted source text stays exactly as written (ADR-0128). Text inside code (fenced, `{code}` or `{noformat}`) is never rewritten, and an
 * unterminated fence leaves the whole text as the heading pass produced it.
 */

// Every pattern below is linear: no two adjacent parts can match the same character, and a label
// or target never spans a further `[`, so hostile input cannot force polynomial backtracking.
const FENCE_INDENT = /^ {0,3}/u;
const FENCE_LANGUAGE = /^[ \t]*([\w+#.-]*)/u;
const MACRO_FENCE = /^\s*\{(code|noformat)(?::[^}]*)?\}\s*$/u;
const BULLET = /^([ \t]*)[-*+][ \t]+([^ \t].*)?$/u;
const ORDERED = /^([ \t]*)\d{1,9}[.)][ \t]+([^ \t].*)?$/u;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_RULE_CELL = /^:?-{3,}:?$/u;
const WIKI_HEADING = /^h[1-6]\.\s/u;
const QUOTED = /^ {0,3}>/u;
const STRONG_OPEN = "";
const STRONG_CLOSE = "";

interface Fence {
  readonly marker: string;
}

/** Splits an inline span into code and prose parts; code parts keep their exact text. */
function inlineParts(line: string): readonly { readonly code: boolean; readonly text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  const pattern = /`([^`\n]+)`/gu;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    parts.push(
      { code: false, text: line.slice(last, match.index) },
      { code: true, text: match[1] ?? "" },
    );
    last = match.index + match[0].length;
  }
  parts.push({ code: false, text: line.slice(last) });
  return parts;
}

const LINK_TARGET = String.raw`((?:[^()\s]|\([^()\s]*\))+)`;
const IMAGE = new RegExp(String.raw`!\[([^[\]\n]*)\]\(` + LINK_TARGET + String.raw`\)`, "gu");
const LINK = new RegExp(String.raw`\[([^[\]\n]+)\]\(` + LINK_TARGET + String.raw`\)`, "gu");
const PROTECTED = /\uE002(\d+)\uE003/gu;

/** Links and images first, kept out of the emphasis pass so a URL's `__` or `*` stays intact. */
function protectLinks(text: string, kept: string[]): string {
  const keep = (wiki: string): string => `\uE002${String(kept.push(wiki) - 1)}\uE003`;
  return text
    .replaceAll(IMAGE, (_match, _alt: string, url: string) => keep(`!${url}!`))
    .replaceAll(LINK, (_match, label: string, url: string) => keep(`[${label}|${url}]`));
}

function proseInline(text: string): string {
  if (text.includes(STRONG_OPEN) || text.includes(STRONG_CLOSE) || text.includes("\uE002"))
    return text;
  const kept: string[] = [];
  return (
    protectLinks(text, kept)
      .replaceAll(/\*\*(?=\S)([^*\n]*?\S)\*\*/gu, `${STRONG_OPEN}$1${STRONG_CLOSE}`)
      // A file name such as `__init__.py` is a name, not emphasis: `__` before `.ext` stays.
      .replaceAll(/(?<!\w)__(?=\S)([^_\n]*?\S)__(?!\w|\.\w)/gu, `${STRONG_OPEN}$1${STRONG_CLOSE}`)
      .replaceAll(/(?<=^|[\s(["'])\*(?=[^\s*])([^*\n]*?[^\s*/])\*(?![*\w])/gu, "_$1_")
      .replaceAll(/~~(?=\S)([^~\n]*?\S)~~/gu, "-$1-")
      .replaceAll(STRONG_OPEN, "*")
      .replaceAll(STRONG_CLOSE, "*")
      .replaceAll(PROTECTED, (_match, index: string) => kept[Number(index)] ?? "")
  );
}

/** Inline code as a wiki monospace span; its braces are escaped so they cannot close the span. */
function monospace(code: string): string {
  const escaped = code.replaceAll(/[{}]/gu, (brace) => "\\" + brace);
  return `{{${escaped}}}`;
}

/** Emphasis, strike, links and images in prose; inline code becomes a `{{monospace}}` span. */
export function markdownInlineToJiraWiki(line: string): string {
  return inlineParts(line)
    .map((part) => (part.code ? monospace(part.text) : proseInline(part.text)))
    .join("");
}

/** Jira wiki lists nest six levels deep. */
const LIST_DEPTH_MAX = 6;

/** One open list item: where its marker starts and the wiki character of its list. */
interface ListLevel {
  readonly indent: number;
  readonly type: "*" | "#";
}

function indentWidth(indent: string): number {
  return indent.replaceAll("\t", "  ").length;
}

function tableCells(line: string): readonly string[] {
  const inner = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return inner.split("|").map((cell) => markdownInlineToJiraWiki(cell.trim()));
}

/**
 * A bullet or numbered item. The wiki marker is the path of its ancestors' list types plus its own
 * (`*#` is a numbered item under a bullet). An item nests under the open item whose marker starts
 * at least two columns before its own, which holds for `- `, `1. ` and `10. ` parents alike.
 */
function listLine(list: ListLevel[], line: string): string | undefined {
  const bullet = BULLET.exec(line);
  const item = bullet ?? ORDERED.exec(line);
  if (item === null) return undefined;
  const indent = indentWidth(item[1] ?? "");
  while (list.length > 0 && indent < (list.at(-1)?.indent ?? 0) + 2) list.pop();
  const type = bullet === null ? "#" : "*";
  list.push({ indent, type });
  const marker = list
    .slice(0, LIST_DEPTH_MAX)
    .map((level) => level.type)
    .join("");
  return `${marker} ${markdownInlineToJiraWiki(item[2] ?? "")}`;
}

/** Whether a non-list line is the wrapped continuation of the open item above it. */
function continuesItem(list: readonly ListLevel[], line: string): boolean {
  const top = list.at(-1);
  if (top === undefined || line.trim() === "") return top !== undefined;
  return indentWidth(/^[ \t]*/u.exec(line)?.[0] ?? "") >= top.indent + 2;
}

/** One line outside code. Wiki headings keep their marker; everything else is block + inline. */
function blockLine(list: ListLevel[], line: string): string {
  const quoted = QUOTED.test(line);
  const rule = RULE.test(line);
  const boundary = quoted || rule || WIKI_HEADING.test(line);
  const item = boundary ? undefined : listLine(list, line);
  if (item !== undefined) return item;
  // A blank line or an indented continuation keeps the list open; any other line ends it.
  if (boundary || !continuesItem(list, line)) list.length = 0;
  if (rule) return "----";
  return quoted ? line : markdownInlineToJiraWiki(line);
}

interface Converter {
  readonly out: string[];
  readonly list: ListLevel[];
  fence: Fence | undefined;
  macro: string | undefined;
  header: boolean;
}

/** An opening fence: up to three spaces, three or more backticks or tildes, an info string. */
function fenceOpen(
  line: string,
): { readonly marker: string; readonly language: string } | undefined {
  const body = line.slice(FENCE_INDENT.exec(line)?.[0].length ?? 0);
  const character = body[0];
  if (character !== "`" && character !== "~") return undefined;
  let length = 0;
  while (body[length] === character) length += 1;
  const info = body.slice(length);
  if (length < 3 || info.includes("`")) return undefined;
  return { marker: body.slice(0, length), language: FENCE_LANGUAGE.exec(info)?.[1] ?? "" };
}

/** A closing fence: the opening character, at least as long, and nothing else on the line. */
function closesFence(marker: string, line: string): boolean {
  const closing = line.trim();
  return closing.length >= marker.length && closing.replaceAll(marker.slice(0, 1), "") === "";
}

/** Inside a fence: every line is literal until its closing fence. */
function activeFenceLine(state: Converter, fence: Fence, line: string): void {
  if (closesFence(fence.marker, line)) {
    state.out.push("{code}");
    state.fence = undefined;
  } else state.out.push(line);
}

function fenceLine(state: Converter, line: string): boolean {
  const open = fenceOpen(line);
  if (open === undefined) return false;
  state.fence = { marker: open.marker };
  state.out.push(open.language.length === 0 ? "{code}" : `{code:${open.language}}`);
  return true;
}

/** Inside a `{code}`/`{noformat}` macro: every line is literal until its closing macro line. */
function activeMacroLine(state: Converter, line: string): void {
  state.out.push(line);
  if (MACRO_FENCE.exec(line)?.[1] === state.macro) state.macro = undefined;
}

function macroLine(state: Converter, line: string): boolean {
  const macro = MACRO_FENCE.exec(line)?.[1];
  if (macro === undefined) return false;
  state.out.push(line);
  state.macro = macro;
  return true;
}

// A table's rule row has a pipe; a bare `---` after a row is a horizontal rule.
function isTableRule(line: string | undefined): boolean {
  if (!line?.includes("|")) return false;
  const inner = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return inner.split("|").every((cell) => TABLE_RULE_CELL.test(cell.trim()));
}

function tableLine(state: Converter, line: string, next: string | undefined): boolean {
  if (isTableRule(line) && state.header) {
    state.header = false;
    return true;
  }
  if (!TABLE_ROW.test(line)) return false;
  const header = isTableRule(next);
  const cells = tableCells(line);
  const separator = header ? "||" : "|";
  state.out.push(`${separator}${cells.join(separator)}${separator}`);
  state.header = header;
  return true;
}

/** Active code states first, so an open block is never reinterpreted; then new blocks. */
function codeOrTableLine(state: Converter, line: string, next: string | undefined): boolean {
  if (state.fence !== undefined) {
    activeFenceLine(state, state.fence, line);
    return true;
  }
  if (state.macro !== undefined) {
    activeMacroLine(state, line);
    return true;
  }
  return fenceLine(state, line) || macroLine(state, line) || tableLine(state, line, next);
}

/**
 * Converts Markdown to Data Center wiki markup, line ending by line ending. The input is expected
 * to have its headings serialized already (`hN. Title`). Returns undefined when a fence is left
 * open, so the caller keeps the text it had instead of a partly rewritten one.
 */
export function markdownBlocksToJiraWiki(text: string): string | undefined {
  const parts = text.split(/(\r\n|\r|\n)/u);
  const lines = parts.filter((_part, index) => index % 2 === 0);
  const state: Converter = {
    out: [],
    list: [],
    fence: undefined,
    macro: undefined,
    header: false,
  };
  for (const [index, line] of lines.entries()) {
    const before = state.out.length;
    if (!codeOrTableLine(state, line, lines[index + 1])) {
      state.header = false;
      state.out.push(blockLine(state.list, line));
    } else state.list.length = 0;
    // A dropped table rule takes its own line ending with it; every kept line keeps its ending.
    if (state.out.length > before)
      state.out[before] = `${state.out[before] ?? ""}${parts[index * 2 + 1] ?? ""}`;
  }
  return state.fence === undefined ? state.out.join("") : undefined;
}

const LINK_SCHEMES = ["https://", "http://", "mailto:", "/", "#"];

/** The label before a `](` at `close`: non-empty, and it spans no bracket or line ending. */
function labelBefore(text: string, close: number): boolean {
  let index = close - 1;
  while (index >= 0 && text[index] !== "[" && text[index] !== "]" && text[index] !== "\n")
    index -= 1;
  return index >= 0 && text[index] === "[" && index < close - 1;
}

/** The target after `](`: a known scheme, then no whitespace or `[`, parentheses balanced one deep. */
function targetAfter(text: string, start: number): boolean {
  if (!LINK_SCHEMES.some((scheme) => text.startsWith(scheme, start))) return false;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "(") {
      if (depth === 1) return false;
      depth = 1;
    } else if (char === ")") {
      if (depth === 0) return true;
      depth = 0;
    } else if (char === "[" || /\s/u.test(char)) return false;
  }
  return false;
}

/**
 * A `[label](target)` link, found by a linear scan: each `](` looks back to its own label and
 * forward to the end of its own target, and neither walk crosses the next bracket or parenthesis.
 */
function hasMarkdownLink(text: string): boolean {
  for (let at = text.indexOf("]("); at >= 0; at = text.indexOf("](", at + 1))
    if (labelBefore(text, at) && targetAfter(text, at + 2)) return true;
  return false;
}

/**
 * Constructs only Markdown writes: `**strong**`, `[text](url)` and fences. A native wiki text uses
 * none of them, while `#` lists, `hN.` headings, `[text|url]` links and macros are wiki's own.
 */
export function readsAsMarkdownOnly(text: string): boolean {
  const markdown =
    /\*\*(?=\S)[^*\n]*?\S\*\*/u.test(text) ||
    hasMarkdownLink(text) ||
    /^ {0,3}(?:`{3,}|~{3,})/mu.test(text);
  const wiki =
    /^h[1-6]\.\s/mu.test(text) ||
    /\{(?:code|noformat|panel|quote|color)[:}]/u.test(text) ||
    /^[^\S\r\n]*\|\|/mu.test(text) ||
    /\[[^[\]|\n]+\|[^[\]\n]+\]/u.test(text) ||
    // Consecutive `# ` lines are a wiki numbered list; Markdown has one title per text.
    /^#[ \t].*\r?\n#[ \t]/mu.test(text);
  return markdown && !wiki;
}
