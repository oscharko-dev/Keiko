/**
 * safe-markdown.ts — hand-rolled, line-based Markdown → AST parser.
 *
 * Design constraints (Issue #150):
 * - ZERO third-party dependencies.
 * - No dangerouslySetInnerHTML anywhere; the caller renders via JSX text nodes.
 * - NO regex used to detect HTML tags — CodeQL js/bad-tag-filter HIGH fires on
 *   any /<script/i style pattern. All tag/attribute scanning uses indexOf().
 * - Link href scheme: only http:// and https:// are allowed. Everything else
 *   (javascript:, data:, vbscript:, file:, etc.) falls through to plain text.
 */

export interface SafeMarkdownNode {
  readonly kind:
    | "paragraph"
    | "heading"
    | "ul"
    | "ol"
    | "li"
    | "code-block"
    | "inline-code"
    | "link"
    | "text"
    | "blockquote"
    | "table"
    | "thead"
    | "tbody"
    | "tr"
    | "th"
    | "td"
    | "strong"
    | "em"
    | "hr";
  readonly children?: readonly SafeMarkdownNode[];
  readonly text?: string;
  readonly level?: 1 | 2 | 3 | 4 | 5 | 6;
  readonly language?: string;
  readonly href?: string;
  readonly align?: "left" | "right" | "center";
}

// ---------------------------------------------------------------------------
// Security: indexOf-based dangerous-content detection.
// Deliberately NOT using regex (CodeQL js/bad-tag-filter HIGH).
// ---------------------------------------------------------------------------

/** Dangerous HTML tag prefixes — checked via .includes(), not regex. */
const DANGEROUS_TAGS = [
  "<script",
  "</script",
  "<iframe",
  "</iframe",
  "<object",
  "</object",
  "<embed",
  "</embed",
  "<style",
  "</style",
  "<svg",
  "</svg",
  "<form",
  "</form",
  "<meta",
  "<link",
  "<base",
] as const;

/** Whitespace-like chars that may precede an on* attribute. */
const ON_ATTR_PREFIXES = [" ", "\n", "\t", "'", '"'] as const;

/** Returns true if the lowercase string contains a dangerous on*= attribute. */
function containsEventHandler(lower: string): boolean {
  let i = 0;
  while (i < lower.length - 4) {
    const c = lower[i];
    if (ON_ATTR_PREFIXES.includes(c as (typeof ON_ATTR_PREFIXES)[number])) {
      if (lower[i + 1] === "o" && lower[i + 2] === "n") {
        let j = i + 3;
        while (j < lower.length && /[a-z]/.test(lower[j] ?? "")) {
          j++;
        }
        if (j < lower.length && lower[j] === "=") return true;
      }
    }
    i++;
  }
  return false;
}

/**
 * Normalizes a string before danger scanning:
 * - lowercases
 * - strips NUL bytes (defence against `<\x00script>` obfuscation)
 * - collapses any ASCII whitespace immediately after `<` so `< script` → `<script`
 * Uses indexOf-based loops — no regex — to stay consistent with the rest of this file.
 */
function normalizeForDangerScan(source: string): string {
  const lower = source.toLowerCase();
  const noNul = lower.replaceAll("\x00", "");
  let out = "";
  for (let i = 0; i < noNul.length; i++) {
    const ch = noNul[i] ?? "";
    if (ch === "<") {
      out += "<";
      while (
        i + 1 < noNul.length &&
        (noNul[i + 1] === " " ||
          noNul[i + 1] === "\t" ||
          noNul[i + 1] === "\n" ||
          noNul[i + 1] === "\r")
      ) {
        i++;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** Returns true if the string contains a dangerous HTML construct. */
export function containsDangerousHtml(s: string): boolean {
  const normalized = normalizeForDangerScan(s);
  for (const tag of DANGEROUS_TAGS) {
    if (normalized.includes(tag)) return true;
  }
  return containsEventHandler(normalized);
}

/** Validates that a link href is safe (only http / https). */
function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

// ---------------------------------------------------------------------------
// Inline parser: turns a string into inline nodes
// ---------------------------------------------------------------------------

/** Flush accumulated plain text into the nodes array. */
function flushText(nodes: SafeMarkdownNode[], raw: string, textStart: number, end: number): void {
  if (end > textStart) {
    nodes.push({ kind: "text", text: raw.slice(textStart, end) });
  }
}

/** Try to parse a backtick inline-code span starting at pos. Returns new pos or -1. */
function tryInlineCode(
  nodes: SafeMarkdownNode[],
  raw: string,
  pos: number,
  textStart: number,
): number {
  if (raw[pos] !== "`") return -1;
  const closeIdx = raw.indexOf("`", pos + 1);
  if (closeIdx === -1) return -1;
  flushText(nodes, raw, textStart, pos);
  nodes.push({ kind: "inline-code", text: raw.slice(pos + 1, closeIdx) });
  return closeIdx + 1;
}

/** Try to parse **bold** or __bold__ starting at pos. Returns new pos or -1. */
function tryBold(nodes: SafeMarkdownNode[], raw: string, pos: number, textStart: number): number {
  const ch = raw[pos];
  const next = raw[pos + 1];
  if (pos + 1 >= raw.length) return -1;
  if (!((ch === "*" && next === "*") || (ch === "_" && next === "_"))) return -1;
  const marker = ch + next; // "**" or "__"
  const closeIdx = raw.indexOf(marker, pos + 2);
  if (closeIdx === -1) return -1;
  flushText(nodes, raw, textStart, pos);
  const inner = raw.slice(pos + 2, closeIdx);
  nodes.push({ kind: "strong", children: parseInline(inner) });
  return closeIdx + 2;
}

/** Find the closing index of a single italic marker (ch). Returns -1 if not found. */
function findItalicClose(raw: string, ch: string, from: number): number {
  for (let k = from; k < raw.length; k++) {
    if (raw[k] === ch && raw[k - 1] !== ch && (k + 1 >= raw.length || raw[k + 1] !== ch)) {
      return k;
    }
  }
  return -1;
}

/** Try to parse *italic* or _italic_ (single marker) starting at pos. Returns new pos or -1. */
function tryItalic(nodes: SafeMarkdownNode[], raw: string, pos: number, textStart: number): number {
  const ch = raw[pos];
  if (ch !== "*" && ch !== "_") return -1;
  if (raw[pos + 1] === ch) return -1; // double-marker handled by tryBold
  if (pos > 0 && raw[pos - 1] === ch) return -1;
  const closeIdx = findItalicClose(raw, ch, pos + 1);
  if (closeIdx === -1) return -1;
  flushText(nodes, raw, textStart, pos);
  nodes.push({ kind: "em", children: parseInline(raw.slice(pos + 1, closeIdx)) });
  return closeIdx + 1;
}

/** Try to parse [text](href) link starting at pos. Returns new pos or -1. */
function tryLink(nodes: SafeMarkdownNode[], raw: string, pos: number, textStart: number): number {
  if (raw[pos] !== "[") return -1;
  const bracketClose = raw.indexOf("]", pos + 1);
  if (bracketClose === -1 || raw[bracketClose + 1] !== "(") return -1;
  const parenClose = raw.indexOf(")", bracketClose + 2);
  if (parenClose === -1) return -1;
  const linkText = raw.slice(pos + 1, bracketClose);
  const href = raw.slice(bracketClose + 2, parenClose);
  flushText(nodes, raw, textStart, pos);
  if (isSafeHref(href) && !containsDangerousHtml(linkText) && !containsDangerousHtml(href)) {
    nodes.push({ kind: "link", text: linkText, href });
  } else {
    nodes.push({ kind: "text", text: `[${linkText}](${href})` });
  }
  return parenClose + 1;
}

const URL_BREAK_CHARS = new Set([" ", "\t", "\n", "<", ">", '"']);
const URL_TRAIL_CHARS = new Set([".", ",", ")", "]", "!", "?"]);

/** Find the end index of a URL starting at pos (exclusive). */
function findUrlEnd(raw: string, pos: number): number {
  let end = pos;
  while (end < raw.length && !URL_BREAK_CHARS.has(raw[end] ?? "")) {
    end++;
  }
  while (end > pos && URL_TRAIL_CHARS.has(raw[end - 1] ?? "")) {
    end--;
  }
  return end;
}

/** Try to auto-link a bare https:// or http:// URL starting at pos. Returns new pos or -1. */
function tryAutoLink(
  nodes: SafeMarkdownNode[],
  raw: string,
  pos: number,
  textStart: number,
): number {
  if (raw[pos] !== "h") return -1;
  const isHttps = raw.slice(pos, pos + 8) === "https://";
  const isHttp = raw.slice(pos, pos + 7) === "http://";
  if (!isHttps && !isHttp) return -1;
  const end = findUrlEnd(raw, pos);
  const minLen = isHttps ? 8 : 7;
  if (end - pos <= minLen) return -1;
  const url = raw.slice(pos, end);
  flushText(nodes, raw, textStart, pos);
  nodes.push({ kind: "link", text: url, href: url });
  return end;
}

function parseInline(raw: string): readonly SafeMarkdownNode[] {
  const nodes: SafeMarkdownNode[] = [];
  let pos = 0;
  let textStart = 0;

  while (pos < raw.length) {
    let newPos = tryInlineCode(nodes, raw, pos, textStart);
    if (newPos !== -1) {
      textStart = newPos;
      pos = newPos;
      continue;
    }

    newPos = tryBold(nodes, raw, pos, textStart);
    if (newPos !== -1) {
      textStart = newPos;
      pos = newPos;
      continue;
    }

    newPos = tryItalic(nodes, raw, pos, textStart);
    if (newPos !== -1) {
      textStart = newPos;
      pos = newPos;
      continue;
    }

    newPos = tryLink(nodes, raw, pos, textStart);
    if (newPos !== -1) {
      textStart = newPos;
      pos = newPos;
      continue;
    }

    newPos = tryAutoLink(nodes, raw, pos, textStart);
    if (newPos !== -1) {
      textStart = newPos;
      pos = newPos;
      continue;
    }

    pos++;
  }

  flushText(nodes, raw, textStart, raw.length);
  return nodes;
}

// ---------------------------------------------------------------------------
// Table parsing helpers
// ---------------------------------------------------------------------------

function parseAlignment(cell: string): "left" | "right" | "center" | undefined {
  const t = cell.trim();
  const startsColon = t.startsWith(":");
  const endsColon = t.endsWith(":");
  if (startsColon && endsColon) return "center";
  if (endsColon) return "right";
  if (startsColon) return "left";
  return undefined;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

function isSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false;
  for (const cell of cells) {
    const t = cell.trim().replace(/^:/, "").replace(/:$/, "");
    if (!/^-+$/.test(t)) return false;
  }
  return true;
}

function makeThNode(
  cell: string,
  align: "left" | "right" | "center" | undefined,
): SafeMarkdownNode {
  const base: SafeMarkdownNode = { kind: "th", children: parseInline(cell.trim()) };
  return align !== undefined ? { ...base, align } : base;
}

function makeTdNode(
  cell: string,
  align: "left" | "right" | "center" | undefined,
): SafeMarkdownNode {
  const base: SafeMarkdownNode = { kind: "td", children: parseInline(cell.trim()) };
  return align !== undefined ? { ...base, align } : base;
}

function parseTable(
  headerLine: string,
  separatorLine: string,
  bodyLines: string[],
): SafeMarkdownNode {
  const headerCells = splitTableRow(headerLine);
  const sepCells = splitTableRow(separatorLine);
  const alignments = sepCells.map(parseAlignment);

  const thNodes = headerCells.map((cell, ci) => makeThNode(cell, alignments[ci]));
  const theadNode: SafeMarkdownNode = {
    kind: "thead",
    children: [{ kind: "tr", children: thNodes }],
  };

  const trNodes = bodyLines.map((line) => {
    const cells = splitTableRow(line);
    const tdNodes = cells.map((cell, ci) => makeTdNode(cell, alignments[ci]));
    return { kind: "tr" as const, children: tdNodes };
  });

  return { kind: "table", children: [theadNode, { kind: "tbody", children: trNodes }] };
}

// ---------------------------------------------------------------------------
// List parsing
// ---------------------------------------------------------------------------

interface ListItemRaw {
  text: string;
  indent: number;
}

function isUnorderedBullet(
  line: string,
): { match: true; indent: number; text: string } | { match: false } {
  const m = /^( *)([*+\-]) (.*)$/.exec(line); // eslint-disable-line no-useless-escape
  if (!m) return { match: false };
  return { match: true, indent: m[1]?.length ?? 0, text: m[3] ?? "" };
}

function isOrderedBullet(
  line: string,
): { match: true; indent: number; text: string } | { match: false } {
  const m = /^( *)\d+\. (.*)$/.exec(line);
  if (!m) return { match: false };
  return { match: true, indent: m[1]?.length ?? 0, text: m[2] ?? "" };
}

function buildListNodes(items: ListItemRaw[], ordered: boolean): SafeMarkdownNode {
  const listKind = ordered ? ("ol" as const) : ("ul" as const);
  const children: SafeMarkdownNode[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    if (item === undefined) {
      i++;
      continue;
    }
    const myIndent = item.indent;

    const nestedItems: ListItemRaw[] = [];
    i++;
    while (i < items.length) {
      const next = items[i];
      if (next === undefined || next.indent <= myIndent) break;
      nestedItems.push(next);
      i++;
    }

    const liChildren: SafeMarkdownNode[] = [...(parseInline(item.text) as SafeMarkdownNode[])];
    if (nestedItems.length > 0) {
      liChildren.push(buildListNodes(nestedItems, ordered));
    }
    children.push({ kind: "li", children: liChildren });
  }

  return { kind: listKind, children };
}

// ---------------------------------------------------------------------------
// Block-level parser helpers
// ---------------------------------------------------------------------------

function isTableRow(line: string): boolean {
  return line.includes("|");
}

function isHrLine(line: string): boolean {
  const t = line.trim();
  return /^(-{3,}|\*{3,}|_{3,})$/.test(t);
}

interface ParseContext {
  lines: string[];
  i: number;
}

function consumeCodeBlock(
  ctx: ParseContext,
  fence: string,
  lang: string | undefined,
): SafeMarkdownNode {
  const codeLines: string[] = [];
  ctx.i++;
  while (ctx.i < ctx.lines.length) {
    const codeLine = ctx.lines[ctx.i] ?? "";
    const closeFence = /^(`{3,}|~{3,})\s*$/.exec(codeLine.trim());
    if (closeFence !== null) {
      const closer = closeFence[1] ?? "";
      if (closer.startsWith(fence[0] ?? "") && closer.length >= fence.length) {
        ctx.i++;
        break;
      }
    }
    codeLines.push(codeLine);
    ctx.i++;
  }
  const codeText = codeLines.join("\n");
  const base: SafeMarkdownNode = { kind: "code-block", text: codeText };
  return lang !== undefined ? { ...base, language: lang } : base;
}

function consumeBlockquote(ctx: ParseContext): SafeMarkdownNode {
  const quoteLines: string[] = [];
  while (ctx.i < ctx.lines.length) {
    const ql = ctx.lines[ctx.i] ?? "";
    if (ql.trimStart().startsWith("> ") || ql.trim() === ">") {
      quoteLines.push(ql.replace(/^( *)> ?/, ""));
      ctx.i++;
    } else {
      break;
    }
  }
  const innerNodes = parseSafeMarkdown(quoteLines.join("\n"));
  return { kind: "blockquote", children: [...innerNodes] };
}

function consumeTable(ctx: ParseContext, headerLine: string): SafeMarkdownNode {
  // ctx.i points at the header line when called — advance past it to reach the separator.
  ctx.i++;
  const separatorLine = ctx.lines[ctx.i] ?? "";
  const bodyLines: string[] = [];
  ctx.i++; // advance past separator to body rows
  while (ctx.i < ctx.lines.length) {
    const tl = ctx.lines[ctx.i] ?? "";
    if (tl.trim() === "" || !isTableRow(tl.trim())) break;
    bodyLines.push(tl);
    ctx.i++;
  }
  return parseTable(headerLine, separatorLine, bodyLines);
}

function consumeList(ctx: ParseContext, ordered: boolean): SafeMarkdownNode {
  const items: ListItemRaw[] = [];
  const checker = ordered ? isOrderedBullet : isUnorderedBullet;
  while (ctx.i < ctx.lines.length) {
    const ll = ctx.lines[ctx.i] ?? "";
    const c = checker(ll);
    if (c.match) {
      items.push({ text: c.text, indent: c.indent });
      ctx.i++;
    } else if (ll.trim() === "") {
      break;
    } else {
      break;
    }
  }
  return buildListNodes(items, ordered);
}

function isBlockStarter(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (/^#{1,6} /.test(t)) return true;
  if (line.trimStart().startsWith("> ")) return true;
  if (/^(`{3,}|~{3,})/.test(t)) return true;
  if (isUnorderedBullet(line).match) return true;
  if (isOrderedBullet(line).match) return true;
  return isHrLine(line);
}

function consumeParagraph(ctx: ParseContext): SafeMarkdownNode | null {
  const paraLines: string[] = [];
  while (ctx.i < ctx.lines.length) {
    const pl = ctx.lines[ctx.i] ?? "";
    if (isBlockStarter(pl)) break;
    paraLines.push(pl);
    ctx.i++;
  }
  if (paraLines.length === 0) return null;
  return { kind: "paragraph", children: parseInline(paraLines.join(" ")) };
}

// ---------------------------------------------------------------------------
// Block dispatcher — returns true if a node was pushed and ctx advanced
// ---------------------------------------------------------------------------

function tryConsumeCodeFence(ctx: ParseContext, line: string, nodes: SafeMarkdownNode[]): boolean {
  const fenceMatch = /^(`{3,}|~{3,})(\S*)/.exec(line.trim());
  if (fenceMatch === null) return false;
  const fence = fenceMatch[1] ?? "```";
  const rawLang = fenceMatch[2];
  const lang = rawLang !== undefined && rawLang.length > 0 ? rawLang : undefined;
  nodes.push(consumeCodeBlock(ctx, fence, lang));
  return true;
}

function tryConsumeHeading(ctx: ParseContext, line: string, nodes: SafeMarkdownNode[]): boolean {
  const headingMatch = /^(#{1,6}) (.+)$/.exec(line.trim());
  if (headingMatch === null) return false;
  const hashes = headingMatch[1] ?? "";
  const level = Math.min(hashes.length, 6) as 1 | 2 | 3 | 4 | 5 | 6;
  const text = headingMatch[2] ?? "";
  nodes.push({ kind: "heading", level, children: parseInline(text) });
  ctx.i++;
  return true;
}

function tryConsumeTable(ctx: ParseContext, line: string, nodes: SafeMarkdownNode[]): boolean {
  if (!isTableRow(line.trim())) return false;
  const nextLine = ctx.lines[ctx.i + 1] ?? "";
  if (!isSeparatorRow(splitTableRow(nextLine))) return false;
  nodes.push(consumeTable(ctx, line));
  return true;
}

function isBlockquoteLine(line: string): boolean {
  return line.trimStart().startsWith("> ") || line.trim() === ">";
}

function tryConsumeList(ctx: ParseContext, line: string, nodes: SafeMarkdownNode[]): boolean {
  if (isUnorderedBullet(line).match) {
    nodes.push(consumeList(ctx, false));
    return true;
  }
  if (isOrderedBullet(line).match) {
    nodes.push(consumeList(ctx, true));
    return true;
  }
  return false;
}

/** Dispatch one block element from ctx. */
function dispatchBlock(ctx: ParseContext, nodes: SafeMarkdownNode[]): void {
  const line = ctx.lines[ctx.i] ?? "";
  if (line.trim() === "") {
    ctx.i++;
    return;
  }
  if (tryConsumeCodeFence(ctx, line, nodes)) return;
  if (tryConsumeHeading(ctx, line, nodes)) return;
  if (isHrLine(line)) {
    nodes.push({ kind: "hr" });
    ctx.i++;
    return;
  }
  if (isBlockquoteLine(line)) {
    nodes.push(consumeBlockquote(ctx));
    return;
  }
  if (tryConsumeTable(ctx, line, nodes)) return;
  if (tryConsumeList(ctx, line, nodes)) return;
  const para = consumeParagraph(ctx);
  if (para !== null) nodes.push(para);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function parseSafeMarkdown(source: string): readonly SafeMarkdownNode[] {
  const nodes: SafeMarkdownNode[] = [];
  const ctx: ParseContext = { lines: source.split("\n"), i: 0 };
  while (ctx.i < ctx.lines.length) {
    dispatchBlock(ctx, nodes);
  }
  return nodes;
}
