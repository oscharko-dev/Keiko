// Static HTML link extraction (Epic #1853, Issue #1872).
//
// Pure, allocation-bounded scan of a static HTML document's navigational links: `<a href>`,
// `<area href>`, `<frame src>`, `<iframe src>`, and `<link rel="canonical" href>`. It extracts raw
// attribute values only; resolution, canonicalisation, and scope enforcement are the guard's job
// (`scope-guard.ts`). It executes no JavaScript and interprets no DOM — this is the static ingestion
// boundary (ADR-0113): rendered capture is a separate, later, security-reviewed path.
//
// The scan is tag-aware: comments, `<script>`/`<style>`/`<textarea>`/`<title>` bodies and visible
// prose are skipped, and only the navigational attribute of a navigational element counts. A
// stylesheet, script, image or media `src`/`href`, a `data-href`, or the text "href=" in a
// paragraph is not a link a crawl should follow or spend its bounded sample on.
//
// Every step moves forward with `indexOf` or a single cursor, so the scan is linear in the
// document and no backtracking regex ever runs on document input (js/polynomial-redos).

import {
  decodeHtmlAttributeEntities,
  decodeHtmlEntities,
  decodeTextFileBytes,
} from "@oscharko-dev/keiko-workspace";

const TAG_NAME_RE = /(\/?)([a-z][a-z0-9:-]*)/iuy;

// Elements whose body is not markup: nothing inside them is a link.
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

// The attribute that carries the navigation target of each navigational element.
const NAVIGATION_ATTRIBUTE: ReadonlyMap<string, string> = new Map([
  ["a", "href"],
  ["area", "href"],
  ["frame", "src"],
  ["iframe", "src"],
]);

const MAX_TITLE_CHARS = 200;

// The page's own byte-order mark or declared charset decides the decoding (a Windows-1252 page
// would otherwise turn every umlaut into U+FFFD); bytes no declared encoding explains fall back to
// lossy UTF-8.
function decodeBytes(bytes: Uint8Array): string {
  const decoded = decodeTextFileBytes(bytes, { scopePath: "page.html" });
  return decoded?.text ?? new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ─── Tag scanner ───────────────────────────────────────────────────────────────

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly attributes: ReadonlyMap<string, string>;
  /** Index just past the tag's closing `>` (the end of the document when unterminated). */
  readonly end: number;
}

const isWhitespace = (char: string): boolean => /[\t\n\f\r ]/u.test(char);

function skipSeparators(html: string, start: number): number {
  let index = start;
  while (index < html.length && (isWhitespace(html.charAt(index)) || html.charAt(index) === "/")) {
    index += 1;
  }
  return index;
}

function readAttributeName(html: string, start: number): number {
  let index = start;
  while (index < html.length && !/[\t\n\f\r />=]/u.test(html.charAt(index))) index += 1;
  return index;
}

// The value after `=`: quoted (to the matching quote; an unterminated quote swallows the rest of
// the document, as browsers do) or bare (to the next blank or `>`).
function readAttributeValue(
  html: string,
  start: number,
): { readonly value: string | undefined; readonly end: number } {
  const quote = html.charAt(start);
  if (quote === '"' || quote === "'") {
    const close = html.indexOf(quote, start + 1);
    return close === -1
      ? { value: undefined, end: html.length }
      : { value: html.slice(start + 1, close), end: close + 1 };
  }
  let index = start;
  while (index < html.length && !/[\t\n\f\r >]/u.test(html.charAt(index))) index += 1;
  return { value: html.slice(start, index), end: index };
}

function skipBlanks(html: string, start: number): number {
  let index = start;
  while (index < html.length && isWhitespace(html.charAt(index))) index += 1;
  return index;
}

// One attribute starting at `start`: its lower-cased name, its value (undefined when it has none
// or its quote never closes) and the index to continue from.
function readAttribute(
  html: string,
  start: number,
): { readonly name: string; readonly value: string | undefined; readonly end: number } {
  const nameEnd = readAttributeName(html, start);
  const name = html.slice(start, nameEnd).toLowerCase();
  const equals = skipBlanks(html, nameEnd);
  if (html.charAt(equals) !== "=") return { name, value: undefined, end: nameEnd };
  const read = readAttributeValue(html, skipBlanks(html, equals + 1));
  return { name, value: read.value, end: read.end };
}

function readTag(html: string, lt: number): Tag | undefined {
  TAG_NAME_RE.lastIndex = lt + 1;
  const head = TAG_NAME_RE.exec(html);
  if (head?.[2] === undefined) return undefined;
  const name = head[2].toLowerCase();
  const closing = head[1] === "/";
  const attributes = new Map<string, string>();
  let index = lt + 1 + head[0].length;
  while (index < html.length) {
    index = skipSeparators(html, index);
    if (html.charAt(index) === ">") return { name, closing, attributes, end: index + 1 };
    const attribute = readAttribute(html, index);
    index = attribute.end;
    if (attribute.name !== "" && attribute.value !== undefined && !attributes.has(attribute.name)) {
      attributes.set(attribute.name, attribute.value);
    }
  }
  return { name, closing, attributes, end: html.length };
}

// Index of the `</name` that closes a raw-text element, or -1 when it is never closed.
function closingTagStart(html: string, name: string, from: number): number {
  let index = html.indexOf("</", from);
  while (index !== -1) {
    const candidate = html.slice(index + 2, index + 2 + name.length).toLowerCase();
    const after = html.charAt(index + 2 + name.length);
    if (candidate === name && (after === ">" || after === "/" || isWhitespace(after))) return index;
    index = html.indexOf("</", index + 2);
  }
  return -1;
}

const COMMENT_END_RE = /--!?>/gu;

// Index after the comment opened at `lt`. Per the HTML standard `<!-->` and `<!--->` are complete
// empty comments and `--!>` ends a comment like `-->` does; an unterminated comment runs to the end.
function commentEnd(html: string, lt: number): number {
  if (html.startsWith(">", lt + 4)) return lt + 5;
  if (html.startsWith("->", lt + 4)) return lt + 6;
  COMMENT_END_RE.lastIndex = lt + 4;
  const close = COMMENT_END_RE.exec(html);
  return close === null ? html.length : close.index + close[0].length;
}

// Index after a comment, declaration or processing instruction starting at `lt`, or undefined when
// `lt` starts an ordinary tag.
function markupDeclarationEnd(html: string, lt: number): number | undefined {
  if (html.startsWith("<!--", lt)) return commentEnd(html, lt);
  if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
    const close = html.indexOf(">", lt + 2);
    return close === -1 ? html.length : close + 1;
  }
  return undefined;
}

function* scanTags(html: string): Generator<Tag> {
  let position = 0;
  // Raw-text elements already known to have no closing tag later in the document: searching again
  // from a later position cannot succeed, and repeating the search would be quadratic.
  const unclosed = new Set<string>();
  while (position < html.length) {
    const lt = html.indexOf("<", position);
    if (lt === -1) return;
    const declarationEnd = markupDeclarationEnd(html, lt);
    if (declarationEnd !== undefined) {
      position = declarationEnd;
      continue;
    }
    const tag = readTag(html, lt);
    if (tag === undefined) {
      position = lt + 1;
      continue;
    }
    position = tag.end;
    if (!tag.closing && RAW_TEXT_ELEMENTS.has(tag.name) && !unclosed.has(tag.name)) {
      // An element that is never closed is markup damage, not a body that swallows the rest of
      // the document: the links after it stay recoverable.
      const close = closingTagStart(html, tag.name, tag.end);
      if (close === -1) unclosed.add(tag.name);
      else position = close;
    }
    yield tag;
  }
}

// ─── Public extraction ─────────────────────────────────────────────────────────

function navigationValue(tag: Tag): string | undefined {
  if (tag.closing) return undefined;
  if (tag.name === "link") {
    const rel = (tag.attributes.get("rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/u);
    return rel.includes("canonical") ? tag.attributes.get("href") : undefined;
  }
  const attribute = NAVIGATION_ATTRIBUTE.get(tag.name);
  return attribute === undefined ? undefined : tag.attributes.get(attribute);
}

// Extract up to `maxLinks` raw navigational link values from an HTML document. Empty values,
// pure fragments (`#…`), and non-navigational schemes are left for the guard to classify; this
// function only bounds the sample and de-duplicates identical raw strings.
export function extractManualLinks(bytes: Uint8Array, maxLinks: number): readonly string[] {
  if (maxLinks <= 0) return [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const tag of scanTags(decodeBytes(bytes))) {
    const raw = navigationValue(tag);
    if (raw === undefined) continue;
    // Single pass over the original text with the HTML attribute-value rules: the whole named
    // table, no legacy semicolon-less reference before `=` or an alphanumeric, and `&amp;#x2f;`
    // stays the literal `&#x2f;` (js/double-escaping).
    const value = decodeHtmlAttributeEntities(raw).trim();
    if (value.length === 0 || value.startsWith("#") || seen.has(value)) continue;
    seen.add(value);
    links.push(value);
    if (links.length >= maxLinks) break;
  }
  return links;
}

// The content of the first `<title>` that is real markup (not inside a comment), or null when the
// element is absent or never closed.
function extractRawTitle(html: string): string | null {
  for (const tag of scanTags(html)) {
    if (tag.name !== "title" || tag.closing) continue;
    const close = closingTagStart(html, "title", tag.end);
    return close === -1 ? null : html.slice(tag.end, close);
  }
  return null;
}

// Extract a page's `<title>` text as a bounded, whitespace-collapsed string, or null when absent.
// Named and numeric entities are decoded as they appear in text (`M&uuml;ller` is Müller). The raw
// title stays internal; the browser-facing pod summary re-applies redaction downstream.
export function extractManualTitle(bytes: Uint8Array): string | null {
  const raw = extractRawTitle(decodeBytes(bytes));
  if (raw === null) return null;
  const title = decodeHtmlEntities(raw).replace(/\s+/gu, " ").trim();
  if (title.length === 0) return null;
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title;
}
