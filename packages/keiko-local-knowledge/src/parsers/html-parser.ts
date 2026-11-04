// HTML parser adapter (Epic #189, Issue #266). Single-pass scanner — NO regex, NO DOM, NO
// new deps. Pure-string traversal.
//
// Security posture:
//   * Embedded JavaScript is NEVER executed. We treat `<script>...</script>` content as a
//     dropped substring; nothing parsed inside it lands in any unit. Same for `<style>` and
//     `<noscript>` whose bodies could contain encoded payloads we do not want to surface to
//     the chunker.
//   * Tag content is consumed by raw string scanning. No `new Function`, no `eval`, no DOM
//     APIs are touched; we cannot accidentally trigger sandbox escape because there is no
//     execution path.
//   * CodeQL `js/bad-tag-filter` does NOT fire: we never use regex to filter tags. We
//     `indexOf("<")` then scan character-by-character to find the matching `>`.
//
// Emits one `html-block` ParsedUnit per visible-content run between heading boundaries.
// `headingPath` is set from the most recent `<h1>`-`<h6>` stack at the moment the block
// opens. Inline text outside any heading produces a `html-block` with `headingPath: []`.
//
// Technical-manual structure (Epic #1855): the `<title>` is captured as a searchable block,
// heading `id`/`name` anchors are stamped as `anchorId`, definition lists become "Term:
// definition" blocks, `<pre>`/`<code>` is preserved verbatim, `<frame>` targets are surfaced as
// redacted navigation references, and a declared `<meta charset>` is cross-checked against the
// decoded byte shape. All structure is emitted as decoded PLAINTEXT — `normalizedText` and every
// unit span remain markup-free (GRD-003).

import {
  decodeBytes,
  diagnostic,
  emptyResult,
  encodingDiagnostic,
  limitSeverity,
  shouldStop,
  textInputRefusal,
} from "./_internal.js";
import { LIST_GROUP, breakBetween, joinedLines } from "./block-text.js";
import { cleanHeaderLabel, neutraliseValue } from "./tabular.js";
import { decodeHtmlEntities } from "@oscharko-dev/keiko-workspace";
import type { DocumentId, ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import type {
  InternalParserResult,
  ParserAdapter,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

// Collapse internal whitespace runs to single spaces and trim. Applied to each block's
// visible text so the cleaned projection reads as flowing prose (the raw HTML had source
// indentation / newlines between inline tags).
function collapseWhitespace(value: string): string {
  let out = "";
  let inWs = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i);
    const ws = code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    if (ws) {
      inWs = true;
      continue;
    }
    if (inWs && out.length > 0) out += " ";
    inWs = false;
    out += value.charAt(i);
  }
  return out;
}

const PARSER_ID = "html";
const PARSER_VERSION = "2";

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS);
const HTML_MEDIA_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);

function isHtml(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) return true;
  if (HTML_MEDIA_TYPES.has(input.mediaType.toLowerCase())) return true;
  // Sniff: a leading `<!DOCTYPE` or `<html` is enough to claim. We never decode beyond a few
  // bytes here; the bigger decode happens inside `parse`.
  const head = input.bytes.subarray(0, 64);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head).trimStart().toLowerCase();
  return text.startsWith("<!doctype html") || text.startsWith("<html");
}

// ─── Token model ─────────────────────────────────────────────────────────────

type TagKind = "open" | "close" | "self-closing";

interface Tag {
  readonly name: string;
  readonly kind: TagKind;
  readonly start: number; // start of `<`
  readonly end: number; // one past `>`
  readonly raw: string;
}

const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "noscript"]);
// `<title>` inner text is captured once, structurally, by `readDocumentTitle` (before <main>
// narrowing). Skipping it in the body scan avoids emitting the title twice when a document has no
// <main> element and the head is therefore part of the scanned text.
const METADATA_TAGS: ReadonlySet<string> = new Set(["title"]);
// Frame/nav-link containers whose `src` targets are surfaced as body-safe navigation references so
// a frameset table-of-contents is discoverable without executing scripts or following the link.
const FRAME_TAGS: ReadonlySet<string> = new Set(["frame", "iframe"]);
const BOILERPLATE_TAGS: ReadonlySet<string> = new Set(["nav", "footer", "aside"]);
// Whole class/id TOKENS (split at every non-alphanumeric character) that mark a wrapper as page
// furniture. A hint inside any other attribute (`data-track="consent-manager"`) or inside a longer
// word never counts, and a wrapper that holds most of the page is content whatever it is called.
const BOILERPLATE_HINTS: ReadonlySet<string> = new Set([
  "cookie",
  "cookies",
  "consent",
  "banner",
  "navbar",
  "breadcrumb",
  "breadcrumbs",
  "sidebar",
  "footer",
]);
const HEADER_BOILERPLATE_HINTS: ReadonlySet<string> = new Set([
  "nav",
  "navbar",
  "navigation",
  "banner",
]);
// A hint-named subtree larger than this share of the document is not removed.
const MAX_REMOVABLE_SHARE = 0.5;
// Measuring candidate subtrees may cost this many times the document length in total.
const EXCLUSION_BUDGET_FACTOR = 4;

// Elements that end the text flow around them: every one of them (opening, closing or void) starts
// a new block, so adjacent paragraphs, list items and lines never fuse into one word. Inline
// elements (`b`, `a`, `span`, …) are absent on purpose: they stay inside the surrounding text.
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "blockquote",
  "body",
  "br",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "form",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "legend",
  "li",
  "main",
  "menu",
  "ol",
  "optgroup",
  "option",
  "p",
  "section",
  "summary",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
// Elements without content or end tag: a subtree walk for them would run to the end of the page.
const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const MAX_ATTRIBUTES_PER_TAG = 64;

const NBSP = String.fromCodePoint(0xa0);
const SOFT_HYPHEN = String.fromCodePoint(0xad);

// Decoded visible text: a non-breaking space is a space (it would otherwise survive whitespace
// collapsing and split `a&nbsp;b` queries), and a soft hyphen is an invisible hint inside a word.
function visibleText(raw: string): string {
  return decodeHtmlEntities(raw).replaceAll(NBSP, " ").replaceAll(SOFT_HYPHEN, "");
}

function isAttributeSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

interface AttributeCursor {
  readonly raw: string;
  position: number;
}

function skipAttributeSpaces(cursor: AttributeCursor): void {
  while (
    cursor.position < cursor.raw.length &&
    isAttributeSpace(cursor.raw.codePointAt(cursor.position) ?? 0)
  ) {
    cursor.position += 1;
  }
}

function readAttributeName(cursor: AttributeCursor): string {
  const start = cursor.position;
  while (cursor.position < cursor.raw.length) {
    const char = cursor.raw[cursor.position] ?? "";
    if (isAttributeSpace(char.codePointAt(0) ?? 0) || "=>/".includes(char)) break;
    cursor.position += 1;
  }
  return cursor.raw.slice(start, cursor.position).toLowerCase();
}

// Value after `=`: quoted (to the closing quote) or bare (to the next space or `>`).
function readAttributeValue(cursor: AttributeCursor): string {
  skipAttributeSpaces(cursor);
  const quote = cursor.raw[cursor.position];
  if (quote === '"' || quote === "'") {
    const close = cursor.raw.indexOf(quote, cursor.position + 1);
    const end = close === -1 ? cursor.raw.length : close;
    const value = cursor.raw.slice(cursor.position + 1, end);
    cursor.position = end + 1;
    return value;
  }
  const start = cursor.position;
  while (
    cursor.position < cursor.raw.length &&
    cursor.raw[cursor.position] !== ">" &&
    !isAttributeSpace(cursor.raw.codePointAt(cursor.position) ?? 0)
  ) {
    cursor.position += 1;
  }
  return cursor.raw.slice(start, cursor.position);
}

// One `name`, `name=value` or stray character; `name` is empty for the latter.
function readNextAttribute(cursor: AttributeCursor): { name: string; value: string } {
  skipAttributeSpaces(cursor);
  while (cursor.raw[cursor.position] === "/") cursor.position += 1;
  const name = readAttributeName(cursor);
  skipAttributeSpaces(cursor);
  const hasValue = cursor.raw[cursor.position] === "=";
  if (hasValue) cursor.position += 1;
  if (name.length === 0 && !hasValue) cursor.position += 1;
  return { name, value: hasValue ? readAttributeValue(cursor) : "" };
}

// Attributes of ONE tag literal, quote-aware, first occurrence wins (HTML semantics). Names are
// lower-cased, values are returned raw (undecoded); a boolean attribute has the empty string.
function parseTagAttributes(raw: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const cursor: AttributeCursor = { raw, position: 1 };
  while (cursor.position < raw.length && !isAttributeSpace(raw.codePointAt(cursor.position) ?? 0)) {
    cursor.position += 1;
  }
  while (cursor.position < raw.length && attributes.size < MAX_ATTRIBUTES_PER_TAG) {
    const { name, value } = readNextAttribute(cursor);
    if (name.length > 0 && !attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

// One attribute of an opening tag, with the quoting HTML allows (double, single or none) and its
// entities decoded; an attribute inside another attribute's value is never read.
function tagAttribute(tagRaw: string, name: string): string | undefined {
  const value = parseTagAttributes(tagRaw).get(name);
  return value === undefined ? undefined : visibleText(value);
}

function attributeTokens(attributes: ReadonlyMap<string, string>): readonly string[] {
  const joined = `${attributes.get("class") ?? ""} ${attributes.get("id") ?? ""}`.toLowerCase();
  return joined.split(/[^a-z0-9]+/u).filter((token) => token.length > 0);
}

// `hidden` attribute or an inline `display:none`: a reader cannot see the element, so it is not
// document text (owner decision, #4235).
function isHiddenByAttributes(attributes: ReadonlyMap<string, string>): boolean {
  if (attributes.has("hidden")) return true;
  const style = (attributes.get("style") ?? "").toLowerCase().replaceAll(/\s+/gu, "");
  return style
    .split(";")
    .some(
      (declaration) => declaration === "display:none" || declaration.startsWith("display:none!"),
    );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameChar(code: number): boolean {
  return isAlpha(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d; /* - */
}

function readTagName(
  text: string,
  from: number,
): { readonly name: string; readonly after: number } {
  let i = from;
  while (i < text.length && isNameChar(text.codePointAt(i) ?? 0)) i += 1;
  return { name: text.slice(from, i).toLowerCase(), after: i };
}

// Returns the next tag starting at or after `from`. Skips comments, CDATA, and DOCTYPE.
function skipSpecialMarker(text: string, after: number): number | null {
  if (text.startsWith("!--", after)) {
    const close = text.indexOf("-->", after + 3);
    return close === -1 ? text.length : close + 3;
  }
  const ch = text.codePointAt(after);
  if (ch === 0x21 /* ! */ || ch === 0x3f /* ? */) {
    const gt = text.indexOf(">", after);
    return gt === -1 ? text.length : gt + 1;
  }
  return null;
}

// The position of the last `>` of the document being scanned, found once per document.
let lastTagEnd: { readonly text: string; readonly at: number } | undefined;

function lastTagEndOf(text: string): number {
  if (lastTagEnd?.text !== text) lastTagEnd = { text, at: text.lastIndexOf(">") };
  return lastTagEnd.at;
}

// Quote-aware scan for a tag's terminating `>`. A single- or double-quoted attribute value may
// contain a literal `>` (e.g. `title="Section > Details"`); a bare `indexOf(">", from)` would
// mis-terminate the tag there, corrupting `tag.raw` and desynchronizing the scanner cursor for
// every subsequent event. This stays a single-pass character scan (no regex) so the CodeQL
// `js/bad-tag-filter` posture is preserved.
function findQuotedTagEnd(text: string, from: number): number {
  let quote = 0; // 0 = not in a quote, else the quote char code (0x22 `"` or 0x27 `'`)
  for (let i = from; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 0x22 || code === 0x27) {
      quote = code;
      continue;
    }
    if (code === 0x3e /* > */) return i;
  }
  return -1;
}

// A stray, never-closed quote in an attribute value (malformed/truncated markup) would otherwise
// leave the quote-aware scan tracking "inside a quote" all the way to end of document, so it never
// finds an unquoted `>` and reports the tag as unterminated. `readTagAt` then treats the tag as
// absent, and the top-level scanner falls back to emitting raw, un-stripped markup as literal text
// for the REST OF THE DOCUMENT — an unbounded leak from a single malformed tag. Bound the damage to
// just this one tag by falling back to a plain `>` search (ignoring quote state) so the scanner
// re-synchronizes on the next tag boundary instead of corrupting everything that follows.
function findTagEnd(text: string, from: number): number {
  // Past the last `>` of the document no tag can end: answering that at once keeps a document made
  // of thousands of tag openings and no `>` linear instead of scanning to its end for each.
  if (from > lastTagEndOf(text)) return -1;
  const quoted = findQuotedTagEnd(text, from);
  if (quoted !== -1) return quoted;
  return text.indexOf(">", from);
}

export function resolveTagKind(isClose: boolean, selfClosing: boolean): TagKind {
  if (isClose) return "close";
  if (selfClosing) return "self-closing";
  return "open";
}

function readTagAt(text: string, lt: number): Tag | null {
  const after = lt + 1;
  const isClose = text.codePointAt(after) === 0x2f; /* / */
  const nameStart = isClose ? after + 1 : after;
  if (!isAlpha(text.codePointAt(nameStart) ?? 0)) return null;
  const { name, after: afterName } = readTagName(text, nameStart);
  const gt = findTagEnd(text, afterName);
  if (gt === -1) return null;
  const selfClosing = !isClose && text.codePointAt(gt - 1) === 0x2f;
  const kind = resolveTagKind(isClose, selfClosing);
  return { name, kind, start: lt, end: gt + 1, raw: text.slice(lt, gt + 1) };
}

type ScanEvent =
  | { readonly kind: "text"; readonly start: number; readonly end: number; readonly next: number }
  | { readonly kind: "tag"; readonly tag: Tag; readonly next: number }
  | { readonly kind: "marker"; readonly next: number }
  | { readonly kind: "eof" };

// Returns the next event starting at `from`. Text events cover inter-tag/inter-marker runs
// only — bytes that are part of a `<!DOCTYPE>` / `<!-- -->` / `<tag>` literal are NEVER
// surfaced as text. This is the contract that keeps `<html>` and `<body>` literals out of
// any html-block span.
function nextEvent(text: string, from: number): ScanEvent {
  if (from >= text.length) return { kind: "eof" };
  const lt = text.indexOf("<", from);
  if (lt === -1) return { kind: "text", start: from, end: text.length, next: text.length };
  if (lt > from) return { kind: "text", start: from, end: lt, next: lt };
  const marker = skipSpecialMarker(text, lt + 1);
  if (marker !== null) return { kind: "marker", next: marker };
  const tag = readTagAt(text, lt);
  if (tag !== null) return { kind: "tag", tag, next: tag.end };
  return { kind: "text", start: lt, end: lt + 1, next: lt + 1 };
}

// For a raw-text tag we MUST skip until the matching close tag with the same name, without
// interpreting the inner bytes. This is what neutralises `<script>...</script>` payloads.
// `textLower` is a precomputed lowercase view threaded from `emitHtml` to avoid recomputing
// it on every raw-text tag — without this, a document with N script/style tags would call
// text.toLowerCase() N times, making the function O(n²) in document size.
function skipRawText(text: string, textLower: string, tagName: string, from: number): number {
  const target = `</${tagName}`;
  const close = textLower.indexOf(target, from);
  if (close === -1) return text.length;
  const gt = text.indexOf(">", close);
  return gt === -1 ? text.length : gt + 1;
}

interface NestableElementEnd {
  // Offset of the matching close tag's `<` — i.e. one past the element's inner content.
  readonly contentEnd: number;
  // Offset one past the matching close tag's `>` — i.e. one past the whole element.
  readonly elementEnd: number;
}

// Depth-aware close for elements that legitimately nest same-named children — `<table>` (a cell
// may contain a sub-table) and `<dl>` (a `<dd>` may contain a nested `<dl>`). A naive
// `indexOf("</table>", from)` (a plain substring search) stops at the FIRST close tag, which for a
// nested table/dl is the INNER element's close — truncating the outer element and silently
// dropping every sibling that follows the nested one. Walks tags via `nextEvent`, counting depth,
// so the returned offsets bracket the matching OUTER close tag. MUST also skip `<script>`/`<style>`/
// `<noscript>` subtrees the same way `fragmentTextRaw`/`readDocumentTitle` do (GRD-003): otherwise a
// raw-text body containing a literal `</table>`/`</dl>`-shaped substring (e.g. a JS string literal)
// is mis-read as a real close tag, prematurely ending the depth-aware scan and leaking the rest of
// the script/style body as ordinary text. `textLower` is the caller's already-lowercased view of
// `text` (never recomputed per call here) so a large table with many rows stays O(n), not O(n²).
// +1 for a matching open tag, -1 for a matching close tag, 0 otherwise. Split out of
// `findNestableElementEnd` purely to keep that function's cyclomatic complexity within the
// repo's limit.
function nestableDepthDelta(tag: Tag, tagName: string): number {
  if (tag.name !== tagName) return 0;
  if (tag.kind === "open") return 1;
  if (tag.kind === "close") return -1;
  return 0;
}

function findNestableElementEnd(
  text: string,
  textLower: string,
  tagName: string,
  from: number,
): NestableElementEnd {
  let depth = 1;
  let cursor = from;
  while (cursor < text.length) {
    const event = nextEvent(text, cursor);
    if (event.kind === "eof") break;
    if (event.kind !== "tag") {
      cursor = event.next;
      continue;
    }
    if (RAW_TEXT_TAGS.has(event.tag.name) && event.tag.kind === "open") {
      cursor = skipRawText(text, textLower, event.tag.name, event.tag.end);
      continue;
    }
    depth += nestableDepthDelta(event.tag, tagName);
    if (depth === 0) return { contentEnd: event.tag.start, elementEnd: event.tag.end };
    cursor = event.next;
  }
  return { contentEnd: text.length, elementEnd: text.length };
}

function skipNestableElement(
  text: string,
  textLower: string,
  tagName: string,
  from: number,
): number {
  return findNestableElementEnd(text, textLower, tagName, from).elementEnd;
}

// Skip past a non-raw-text container (`<title>`, `<pre>`, boilerplate `<nav>`/`<footer>`/`<aside>`)
// to its matching close tag. This MUST go through the same RAW_TEXT_TAGS-aware, depth-tracking walk
// as `skipNestableElement` (GRD-003) rather than a plain `indexOf("</" + tagName)` substring search:
// a `<script>` nested inside one of these containers whose body happens to contain a literal
// `</pre>`/`</title>`/`</nav>`/`</footer>`/`</aside>`-shaped substring (e.g. a JS string literal)
// would otherwise be mis-read as the container's own close tag, prematurely ending the skip and
// leaking the remainder of the still-open `<script>` body as ordinary text on the next scan step.
function skipElement(text: string, textLower: string, tagName: string, from: number): number {
  return skipNestableElement(text, textLower, tagName, from);
}

function hintsFor(tagName: string): ReadonlySet<string> | undefined {
  if (tagName === "header") return HEADER_BOILERPLATE_HINTS;
  return tagName === "div" || tagName === "section" ? BOILERPLATE_HINTS : undefined;
}

type SubtreeVerdict = "none" | "boilerplate-tag" | "boilerplate-hint" | "hidden";

// Whether an opening tag starts a subtree that is not document text. Semantic page furniture
// (`nav`, `footer`, `aside`) is always dropped; a wrapper is dropped only for a class/id TOKEN that
// names furniture, and the caller still refuses to drop one that holds most of the page.
function classifySubtree(tag: Tag): SubtreeVerdict {
  if (tag.kind !== "open") return "none";
  if (BOILERPLATE_TAGS.has(tag.name)) return "boilerplate-tag";
  if (VOID_TAGS.has(tag.name) || tag.raw.length <= tag.name.length + 3) return "none";
  const attributes = parseTagAttributes(tag.raw);
  if (isHiddenByAttributes(attributes)) return "hidden";
  const hints = hintsFor(tag.name);
  if (hints === undefined) return "none";
  return attributeTokens(attributes).some((token) => hints.has(token))
    ? "boilerplate-hint"
    : "none";
}

// The `<main>` element: found with the same tag scanner as the body, so `<main>` inside a script,
// a comment or a longer name (`<mainframe>`, `<main-nav>`) is never mistaken for it.
function selectMainContent(text: string): string {
  const textLower = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const event = nextEvent(text, cursor);
    if (event.kind === "eof") break;
    if (event.kind !== "tag") {
      cursor = event.next;
      continue;
    }
    const { tag } = event;
    if (RAW_TEXT_TAGS.has(tag.name) && tag.kind === "open") {
      cursor = skipRawText(text, textLower, tag.name, tag.end);
    } else if (tag.name === "main" && tag.kind === "open") {
      return text.slice(
        tag.start,
        findNestableElementEnd(text, textLower, "main", tag.end).elementEnd,
      );
    } else {
      cursor = event.next;
    }
  }
  return text;
}

// ─── Heading stack ───────────────────────────────────────────────────────────

function headingLevel(name: string): number {
  if (name.length !== 2 || name.codePointAt(0) !== 0x68 /* h */) return 0;
  const code = name.codePointAt(1) ?? 0;
  if (code < 0x31 || code > 0x36) return 0;
  return code - 0x30;
}

interface HeadingState {
  readonly stack: string[];
}

function pushHeading(state: HeadingState, level: number, label: string): void {
  while (state.stack.length >= level) state.stack.pop();
  state.stack.push(label);
}

// ─── Emission ────────────────────────────────────────────────────────────────

interface Emission {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly normalizedText: string;
}

interface ScanState {
  readonly text: string;
  readonly textLower: string; // precomputed once to avoid O(n²) re-lowering in skipRawText
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly units: ParsedUnit[];
  readonly diagnostics: ParserDiagnostic[];
  readonly heading: HeadingState;
  pendingBlockStart: number | null;
  pendingBlockHasText: boolean;
  pendingHeadingLabel: string | null;
  pendingHeadingLevel: number;
  // Nearest in-document fragment anchor for emitted blocks — updated when a heading or `<a>` tag
  // carries an `id`/`name`. Body-safe: a fragment slug, never a full URL. Stamped as `anchorId`.
  currentAnchor: string | undefined;
  stopped: boolean;
  // Open lists, innermost last: the marker of the next list item and the indentation of nested items.
  readonly lists: { ordered: boolean; count: number }[];
  // Marker of the list item whose text has not been emitted yet.
  pendingMarker: string | undefined;
  // Subtrees left out of the text because a reader does not see them as document content.
  excludedBoilerplate: number;
  excludedHidden: number;
  // Characters the scan may still spend measuring subtrees it might exclude. A kept wrapper is
  // measured again by every wrapper nested in it, so the total is bounded to stay linear.
  exclusionBudget: number;
  // Tables rendered so far (names the next table's rows) and whether the next block must be set off
  // from a table's last row by an empty line, which is what ends a projected row.
  tableCount: number;
  // The group of the block written last; only blocks of one group stay on adjacent lines.
  blockGroup: string | undefined;
  blockGroupCount: number;
  // GRD-003: build a cleaned, tag/script/style-free normalizedText projection and re-base
  // unit offsets onto it (mirrors the xlsx parser). The raw bytes — including <script> bodies
  // and embedded secrets — must NEVER become the persisted normalized_text / LLM excerpt.
  blockText: string; // accumulator for the current block's visible text
  readonly cleanedParts: string[]; // joined into the final normalizedText
  cleanedOffset: number; // running length of cleanedParts.join("")
}

function isWhitespaceOnly(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const code = text.codePointAt(i);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

function resetBlock(state: ScanState): void {
  state.pendingBlockStart = null;
  state.pendingBlockHasText = false;
  state.blockText = "";
}

// Records WHY the scan stopped, exactly once, and reports whether it has stopped. Every caller that
// can halt the scan routes through here so a stopped scan never accumulates a second, identical
// diagnostic: `stopped` used to be set only inside `flushBlock` (which resets the pending block,
// making the final unconditional flush a no-op), and the cooperative scan-loop check added for
// #2637 broke that invariant.
function recordScanLimit(state: ScanState): boolean {
  if (state.stopped) return true;
  const limit = shouldStop(state.startedAt, state.options, state.units.length);
  if (!limit.stop || limit.code === undefined || limit.message === undefined) return false;
  state.diagnostics.push(
    diagnostic(limit.code, limit.message, state.input.documentId, limitSeverity(limit.code)),
  );
  state.stopped = true;
  return true;
}

// The break between two blocks is a gap not covered by any unit range: a blank line, except between
// the items of a list and the rows of a table or definition list (block-text.ts).
function pushSeparator(state: ScanState, group: string | undefined): void {
  if (state.cleanedParts.length > 0) {
    const separator = breakBetween(state.blockGroup, group);
    state.cleanedParts.push(separator);
    state.cleanedOffset += separator.length;
  }
  state.blockGroup = group;
}

function nextBlockGroup(state: ScanState): string {
  state.blockGroupCount += 1;
  return `group:${String(state.blockGroupCount)}`;
}

function flushBlock(state: ScanState, end: number): void {
  // Any block boundary ends a heading that was never closed.
  finishHeading(state);
  if (state.pendingBlockStart === null) return;
  if (end <= state.pendingBlockStart || !state.pendingBlockHasText) {
    resetBlock(state);
    return;
  }
  if (recordScanLimit(state)) {
    resetBlock(state);
    return;
  }
  // Offsets index the CLEANED projection, not the raw HTML — so citation slices and chunk
  // spans never expose tags, <script>/<style> bodies, or embedded secrets.
  const collapsed = collapseWhitespace(state.blockText);
  if (collapsed.length === 0) {
    resetBlock(state);
    return;
  }
  // A list item's marker leads the first block with text and is spent with it.
  const cleaned = `${state.pendingMarker ?? ""}${collapsed}`;
  const group = state.pendingMarker === undefined ? undefined : LIST_GROUP;
  state.pendingMarker = undefined;
  pushSeparator(state, group);
  const start = state.cleanedOffset;
  state.cleanedParts.push(cleaned);
  state.cleanedOffset += cleaned.length;
  state.units.push({
    kind: "html-block",
    documentId: state.input.documentId,
    headingPath: [...state.heading.stack],
    ...(state.currentAnchor !== undefined ? { anchorId: state.currentAnchor } : {}),
    characterStart: start,
    characterEnd: state.cleanedOffset,
  });
  resetBlock(state);
}

// Push a fully-rendered block (already collapsed or verbatim) onto the cleaned projection and emit
// the matching html-block unit. Shared by the collapsed (`pushCleanedBlock`) and verbatim
// (`pushVerbatimBlock`) paths so offset math and anchor stamping stay identical.
function pushRenderedBlock(state: ScanState, rendered: string, group?: string): void {
  if (rendered.length === 0) return;
  if (recordScanLimit(state)) return;
  pushSeparator(state, group);
  const start = state.cleanedOffset;
  state.cleanedParts.push(rendered);
  state.cleanedOffset += rendered.length;
  state.units.push({
    kind: "html-block",
    documentId: state.input.documentId,
    headingPath: [...state.heading.stack],
    ...(state.currentAnchor !== undefined ? { anchorId: state.currentAnchor } : {}),
    characterStart: start,
    characterEnd: state.cleanedOffset,
  });
}

function pushCleanedBlock(state: ScanState, text: string, group?: string): void {
  pushRenderedBlock(state, collapseWhitespace(text), group);
}

// Verbatim variant for <pre>/<code> so code indentation, line breaks, and exact identifiers are
// preserved for lexical retrieval instead of being flattened by `collapseWhitespace`. Only
// leading/trailing blank lines are trimmed; interior whitespace is kept byte-for-byte.
function pushVerbatimBlock(state: ScanState, text: string): void {
  let start = 0;
  let end = text.length;
  while (start < end && text.codePointAt(start) === 0x0a) start += 1;
  while (end > start && text.codePointAt(end - 1) === 0x0a) end -= 1;
  pushRenderedBlock(state, text.slice(start, end));
}

// Shared by <pre>/<code> verbatim capture, <dl> definitions, <table> cells, and <title>: walks an
// already-sliced element-HTML fragment and returns its visible text. MUST skip any nested
// `<script>`/`<style>`/`<noscript>` subtree the same way the top-level body scanner does — a
// script/style body must never survive tag-stripping into the persisted normalizedText (GRD-003),
// regardless of which container element it happens to be nested inside.
function walkFragment(
  fragment: string,
  onText: (text: string) => void,
  onTag: (name: string) => void,
): void {
  const fragmentLower = fragment.toLowerCase();
  let cursor = 0;
  while (cursor < fragment.length) {
    const event = nextEvent(fragment, cursor);
    if (event.kind === "eof") break;
    if (event.kind === "text") {
      onText(fragment.slice(event.start, event.end));
      cursor = event.next;
      continue;
    }
    if (event.kind === "tag" && RAW_TEXT_TAGS.has(event.tag.name) && event.tag.kind === "open") {
      cursor = skipRawText(fragment, fragmentLower, event.tag.name, event.tag.end);
      continue;
    }
    if (event.kind === "tag") onTag(event.tag.name);
    cursor = event.next;
  }
}

function fragmentTextRaw(fragment: string): string {
  let out = "";
  walkFragment(
    fragment,
    (text) => {
      out += text;
    },
    () => undefined,
  );
  return visibleText(out);
}

// What a table cell shows, line by line: a line break in the source is white space, a block tag or
// `<br>` starts a new line, so a list or the paragraphs in a cell stay apart.
function fragmentLines(fragment: string): string {
  const parts: string[] = [];
  walkFragment(
    fragment,
    (text) => {
      parts.push(visibleText(text).replaceAll(/[ \t\r\n]+/gu, " "));
    },
    (name) => {
      if (BLOCK_TAGS.has(name)) parts.push("\n");
    },
  );
  return joinedLines(parts.join("").replaceAll(/ {2,}/gu, " "));
}

function htmlFragmentText(fragment: string): string {
  return fragmentLines(fragment).replaceAll("\n", " ");
}

interface ElementSpan {
  readonly name: string;
  readonly innerHtml: string;
  // The matched element's own opening tag, verbatim — so callers can read attributes (e.g. a
  // table cell's `colspan`/`rowspan`) without re-scanning the fragment.
  readonly tagRaw: string;
}

// Extracts TOP-LEVEL `<name>...</name>` elements (any of `tagNames`) from an already-sliced
// fragment of element HTML, depth-aware per tag name so a nested element of the SAME name (a
// sub-table cell, a nested `<dl>`) does not truncate the outer element at its first inner close
// tag — the same bug class `skipNestableElement` fixes for the top-level `<table>`/`<dl>` scan.
// Elements nested inside one of the matched tags are NOT separately returned (e.g. a `<td>`
// inside a `<td>` is invalid HTML and out of scope; a `<dt>`/`<dd>` inside a `<dd>` — from a
// nested `<dl>` — is folded into the parent's innerHtml and flattened by `htmlFragmentText`).
function extractElements(html: string, tagNames: ReadonlySet<string>): readonly ElementSpan[] {
  // Lowercased once per call (not per matched tag) so a table with many rows/cells stays O(n)
  // across the whole extraction instead of re-lowering the same fragment on every match.
  const htmlLower = html.toLowerCase();
  const spans: ElementSpan[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const event = nextEvent(html, cursor);
    if (event.kind === "eof") break;
    if (event.kind !== "tag") {
      cursor = event.next;
      continue;
    }
    if (event.tag.kind === "open" && tagNames.has(event.tag.name)) {
      const bounds = findNestableElementEnd(html, htmlLower, event.tag.name, event.tag.end);
      spans.push({
        name: event.tag.name,
        innerHtml: html.slice(event.tag.end, bounds.contentEnd),
        tagRaw: event.tag.raw,
      });
      cursor = bounds.elementEnd;
      continue;
    }
    cursor = event.next;
  }
  return spans;
}

// The items of a table or a definition list, with the end tags HTML lets a document leave out: a row
// ends where the next row or section starts, a cell where the next cell or its row ends, a term or
// definition where the next one starts. Only items of the container itself count; the rows of a table
// nested in a cell and the terms of a list nested in a definition belong to that inner container.
interface ImpliedSpec {
  readonly container: string;
  readonly items: ReadonlySet<string>;
  /** Other opening tags that end the open item. */
  readonly ends: ReadonlySet<string>;
  /** Closing tags that end the open item. */
  readonly closes: ReadonlySet<string>;
}

interface ImpliedSpan extends ElementSpan {
  /** The item sits in a `<thead>`. */
  readonly inHead: boolean;
}

interface OpenItem {
  readonly name: string;
  readonly tagRaw: string;
  readonly from: number;
  readonly inHead: boolean;
}

const TABLE_SECTIONS: ReadonlySet<string> = new Set(["thead", "tbody", "tfoot"]);
const ROW_SPEC: ImpliedSpec = {
  container: "table",
  items: new Set(["tr"]),
  ends: TABLE_SECTIONS,
  closes: new Set(["tr", ...TABLE_SECTIONS]),
};
const CELL_SPEC: ImpliedSpec = {
  container: "table",
  items: new Set(["td", "th"]),
  ends: new Set(["tr", ...TABLE_SECTIONS]),
  closes: new Set(["td", "th", "tr", ...TABLE_SECTIONS]),
};
const DEFINITION_SPEC: ImpliedSpec = {
  container: "dl",
  items: new Set(["dt", "dd"]),
  ends: new Set(),
  closes: new Set(["dt", "dd"]),
};

// `baseDepth` is how many containers are already open at the start of `html`: 1 when the fragment
// still carries its own container tags, 0 when it is the container's content.
function extractImplied(
  html: string,
  spec: ImpliedSpec,
  baseDepth: number,
): readonly ImpliedSpan[] {
  const htmlLower = html.toLowerCase();
  const spans: ImpliedSpan[] = [];
  let open: OpenItem | undefined;
  let depth = 0;
  let inHead = false;
  const finish = (at: number): void => {
    if (open === undefined) return;
    spans.push({
      name: open.name,
      innerHtml: html.slice(open.from, at),
      tagRaw: open.tagRaw,
      inHead: open.inHead,
    });
    open = undefined;
  };
  let cursor = 0;
  while (cursor < html.length) {
    const event = nextEvent(html, cursor);
    if (event.kind === "eof") break;
    if (event.kind !== "tag") {
      cursor = event.next;
      continue;
    }
    const { tag } = event;
    if (RAW_TEXT_TAGS.has(tag.name) && tag.kind === "open") {
      cursor = skipRawText(html, htmlLower, tag.name, tag.end);
      continue;
    }
    cursor = event.next;
    if (tag.name === spec.container) {
      if (tag.kind === "open") depth += 1;
      if (tag.kind === "close") {
        if (depth - 1 < baseDepth) finish(tag.start);
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (depth !== baseDepth) continue;
    const opens = tag.kind !== "close";
    if (opens && spec.items.has(tag.name)) {
      finish(tag.start);
      open = { name: tag.name, tagRaw: tag.raw, from: tag.end, inHead };
    } else if ((opens && spec.ends.has(tag.name)) || (!opens && spec.closes.has(tag.name))) {
      finish(tag.start);
    }
    if (tag.name === "thead") inHead = opens;
    else if (opens && TABLE_SECTIONS.has(tag.name)) inHead = false;
  }
  finish(html.length);
  return spans;
}

// Bounds a `colspan`/`rowspan` attribute value to a sane positive integer so a malformed or
// hostile table (e.g. `colspan="999999999"`) cannot force an unbounded column-expansion loop.
const MAX_CELL_SPAN = 1000;
const MAX_EXPANDED_CELLS_PER_TABLE = 20_000;

function readSpanCount(tagRaw: string, attribute: string): number {
  const raw = tagAttribute(tagRaw, attribute);
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_CELL_SPAN);
}

interface TableCell {
  readonly header: boolean;
  readonly text: string;
  readonly colspan: number;
  readonly rowspan: number;
}

function tableCells(rowHtml: string): readonly TableCell[] {
  return extractImplied(rowHtml, CELL_SPEC, 0).map((cell) => ({
    header: cell.name === "th",
    text: fragmentLines(cell.innerHtml),
    colspan: readSpanCount(cell.tagRaw, "colspan"),
    rowspan: readSpanCount(cell.tagRaw, "rowspan"),
  }));
}

interface TableExpansionBudget {
  remaining: number;
}

// A cell that spans rows keeps occupying its column(s) in the rows below it.
interface HeldCell {
  readonly cell: TableCell;
  left: number;
}

interface LaidOutRow {
  // One slot per logical column: a `colspan` cell fills every column it covers and a `rowspan` cell
  // of an earlier row fills its column again, so header-to-value pairing stays by column.
  readonly cells: readonly TableCell[];
  // Every cell that starts in this row is a header cell: the row is part of the table header.
  readonly headerOnly: boolean;
  readonly truncated: boolean;
}

interface RowLayout {
  readonly cells: TableCell[];
  column: number;
  truncated: boolean;
}

// Fills the columns held by `rowspan` cells of earlier rows, starting at the current column.
function fillHeldColumns(
  layout: RowLayout,
  held: Map<number, HeldCell>,
  budget: TableExpansionBudget,
): void {
  for (let entry = held.get(layout.column); entry !== undefined; entry = held.get(layout.column)) {
    if (budget.remaining === 0) {
      layout.truncated = true;
      return;
    }
    layout.cells.push(entry.cell);
    budget.remaining -= 1;
    entry.left -= 1;
    if (entry.left <= 0) held.delete(layout.column);
    layout.column += 1;
  }
}

function placeCell(
  layout: RowLayout,
  cell: TableCell,
  held: Map<number, HeldCell>,
  budget: TableExpansionBudget,
): void {
  for (let i = 0; i < cell.colspan; i += 1) {
    if (budget.remaining === 0) {
      layout.truncated = true;
      return;
    }
    layout.cells.push(cell);
    budget.remaining -= 1;
    if (cell.rowspan > 1) held.set(layout.column, { cell, left: cell.rowspan - 1 });
    layout.column += 1;
  }
}

// Read through a function so control-flow analysis does not narrow the flag the helpers mutate.
function isTruncated(layout: RowLayout): boolean {
  return layout.truncated;
}

function layoutRow(
  row: readonly TableCell[],
  held: Map<number, HeldCell>,
  budget: TableExpansionBudget,
): LaidOutRow {
  const layout: RowLayout = { cells: [], column: 0, truncated: false };
  for (const cell of row) {
    fillHeldColumns(layout, held, budget);
    if (isTruncated(layout)) break;
    placeCell(layout, cell, held, budget);
    if (isTruncated(layout)) break;
  }
  if (!isTruncated(layout)) fillHeldColumns(layout, held, budget);
  return {
    cells: layout.cells,
    headerOnly: row.length > 0 && row.every((cell) => cell.header),
    truncated: layout.truncated,
  };
}

interface TableGrid {
  readonly rows: readonly LaidOutRow[];
  // Rows inside `<thead>`: header rows even when their cells are `td`.
  readonly theadRows: number;
}

function tableGrid(state: ScanState, tableHtml: string): TableGrid {
  const budget: TableExpansionBudget = { remaining: MAX_EXPANDED_CELLS_PER_TABLE };
  const held = new Map<number, HeldCell>();
  const rows: LaidOutRow[] = [];
  const sourceRows = extractImplied(tableHtml, ROW_SPEC, 1);
  for (const row of sourceRows) {
    if (recordScanLimit(state)) break;
    const laidOut = layoutRow(tableCells(row.innerHtml), held, budget);
    rows.push(laidOut);
    if (!laidOut.truncated) continue;
    state.diagnostics.push(
      diagnostic(
        "UNIT_LIMIT_REACHED",
        "table exceeded the maximum expanded-cell budget; remaining cells were skipped",
        state.input.documentId,
        "warning",
      ),
    );
    break;
  }
  return { rows, theadRows: sourceRows.filter((row) => row.inHead).length };
}

function neutralColumnLabel(index: number): string {
  return `Column ${String(index + 1)}`;
}

function normalizeHeaders(headers: readonly string[], count: number): readonly string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: count }, (_, index) => {
    const label = cleanHeaderLabel(headers[index] ?? "");
    const base = label.length > 0 ? label : `Column ${String(index + 1)}`;
    const seenCount = seen.get(base) ?? 0;
    seen.set(base, seenCount + 1);
    return seenCount === 0 ? base : `${base} ${String(seenCount + 1)}`;
  });
}

const CAPTION_TAGS: ReadonlySet<string> = new Set(["caption"]);

// `<caption>` names the table (e.g. "Table 4-2: HTTP Status Codes") but lives inside the
// `<table>` element the body scan otherwise skips wholesale via `skipNestableElement` — without
// surfacing it separately here, the one span of text that LABELS the table is silently lost, even
// though every other table cell is preserved. Emitted as its own block (not folded into a row) so
// exact-match retrieval on the caption text is not diluted by cell data.
function appendTableCaption(state: ScanState, tableHtml: string, group: string): void {
  const caption = extractElements(tableHtml, CAPTION_TAGS)[0];
  if (caption === undefined) return;
  const text = htmlFragmentText(caption.innerHtml);
  if (text.length === 0) return;
  pushCleanedBlock(state, `Table caption: ${text}`, group);
}

type TableLayout =
  | { readonly kind: "columns"; readonly headerRows: number }
  | { readonly kind: "rows" }
  | { readonly kind: "none" };

const LETTER = /[A-Za-z_]/u;
const EMPTY_CELL: TableCell = { header: false, text: "", colspan: 1, rowspan: 1 };

function leadingHeaderRows(grid: TableGrid): number {
  let count = 0;
  while (grid.rows[count]?.headerOnly === true) count += 1;
  return Math.max(count, grid.theadRows);
}

function hasHeaderCells(rows: readonly LaidOutRow[]): boolean {
  return rows.some((row) => row.cells.some((cell) => cell.header));
}

// What the table says about its own orientation, in order of evidence: header rows (a `thead`, or
// rows made of `th`), a `th` in the first column of every row (row headers), a plain two-column
// table without any `th` (label and value), and only then the weak guess that a first row with
// letters names the columns.
function tableLayout(grid: TableGrid): TableLayout {
  const { rows } = grid;
  const lead = leadingHeaderRows(grid);
  if (lead > 0)
    return lead < rows.length ? { kind: "columns", headerRows: lead } : { kind: "none" };
  if (rows.length < 2) return { kind: "none" };
  if (rows.every((row) => row.cells[0]?.header === true)) return { kind: "rows" };
  if (!hasHeaderCells(rows) && rows.every((row) => row.cells.length === 2)) return { kind: "rows" };
  const first = rows[0]?.cells ?? [];
  return first.some((cell) => cell.header || LETTER.test(cell.text))
    ? { kind: "columns", headerRows: 1 }
    : { kind: "none" };
}

// One label per column from the header rows; a cell spanning several rows or columns counts once per
// column, and a label that repeats an earlier header row's cell is not repeated.
function columnHeaders(headerRows: readonly LaidOutRow[], count: number): readonly string[] {
  const labels = Array.from({ length: count }, (_, column) => {
    const parts: string[] = [];
    let previous: TableCell | undefined;
    for (const row of headerRows) {
      const cell = row.cells[column];
      if (cell !== undefined && cell !== previous && cell.text.length > 0) parts.push(cell.text);
      previous = cell;
    }
    return parts.join(" ");
  });
  return normalizeHeaders(labels, count);
}

function isEmptyRow(row: LaidOutRow): boolean {
  return row.cells.every((cell) => cell.text.length === 0);
}

function rowCells(row: LaidOutRow, layout: TableLayout, headers: readonly string[]): string {
  if (layout.kind === "rows") {
    const [label, ...values] = row.cells.map((cell) => cell.text);
    return `${cleanHeaderLabel(label ?? "")}=${values.map((value) => neutraliseValue(value)).join(" | ")}`;
  }
  return row.cells
    .map(
      (cell, index) =>
        `${headers[index] ?? neutralColumnLabel(index)}=${neutraliseValue(cell.text)}`,
    )
    .join(" | ");
}

// A table of plain label/value rows describes ONE thing (a requirement's id, title, priority, ...):
// it reads as a single record. A long one is a glossary and keeps one row per line.
const MAX_RECORD_ROWS = 64;

function isRecordTable(grid: TableGrid, layout: TableLayout): boolean {
  return (
    layout.kind === "rows" &&
    grid.rows.length <= MAX_RECORD_ROWS &&
    grid.rows.every((row) => row.cells.length === 2)
  );
}

// The name a table's rows carry, in the shape of a spreadsheet row reference (`Sheet!2:`) that the
// requirement inventory already reads for workbooks; the number is the row's position in the table.
function tableName(state: ScanState): string {
  state.tableCount += 1;
  return state.tableCount === 1 ? "Table" : `Table ${String(state.tableCount)}`;
}

interface TableLine {
  readonly number: number;
  readonly text: string;
}

function tableLines(grid: TableGrid, layout: TableLayout): readonly TableLine[] {
  const headerCount = layout.kind === "columns" ? layout.headerRows : 0;
  const maxCells = grid.rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const headers =
    layout.kind === "columns"
      ? columnHeaders(grid.rows.slice(0, headerCount), maxCells)
      : normalizeHeaders([], maxCells);
  // A header cell that spans into the rows below the header labels its column; it is not a value.
  const headerCells = new Set(grid.rows.slice(0, headerCount).flatMap((row) => row.cells));
  const lines: TableLine[] = [];
  for (const [index, row] of grid.rows.entries()) {
    if (index < headerCount) continue;
    const values: LaidOutRow = {
      ...row,
      cells: row.cells.map((cell) => (headerCells.has(cell) ? EMPTY_CELL : cell)),
    };
    if (!isEmptyRow(values)) {
      lines.push({ number: index + 1, text: rowCells(values, layout, headers) });
    }
  }
  return lines;
}

function appendTableRows(state: ScanState, tableHtml: string): void {
  const group = nextBlockGroup(state);
  appendTableCaption(state, tableHtml, group);
  const grid = tableGrid(state, tableHtml);
  if (grid.rows.length === 0) return;
  const name = tableName(state);
  const layout = tableLayout(grid);
  const lines = tableLines(grid, layout);
  const emitted = isRecordTable(grid, layout)
    ? [{ number: 1, text: lines.map((line) => line.text).join(" | ") }]
    : lines;
  for (const line of emitted) {
    if (state.stopped) break;
    pushRenderedBlock(state, `${name}!${String(line.number)}: ${line.text}`, group);
  }
}

// ─── Definition lists ────────────────────────────────────────────────────────

// Pair each `<dt>` term with its following `<dd>` definition(s). Mirrors the table extractor:
// Depth-aware TOP-LEVEL `<dt>`/`<dd>` walk via `extractElements` (not a non-greedy regex — a
// `<dd>` containing its own nested `<dl>` would otherwise truncate at the INNER list's first
// `</dd>`/`</dt>`, silently dropping every sibling term/definition that follows the nested list).

function definitionEntries(
  dlHtml: string,
): readonly { readonly term: string; readonly definition: string }[] {
  const entries: { term: string; definition: string }[] = [];
  let term: string | undefined;
  for (const element of extractImplied(dlHtml, DEFINITION_SPEC, 1)) {
    const text = htmlFragmentText(element.innerHtml);
    if (element.name === "dt") {
      term = text;
    } else if (term !== undefined && term.length > 0) {
      entries.push({ term, definition: text });
    }
  }
  return entries;
}

function appendDefinitionList(state: ScanState, dlHtml: string): void {
  const group = nextBlockGroup(state);
  for (const entry of definitionEntries(dlHtml)) {
    if (state.stopped) return;
    // "Term: definition" keeps the term attached to its definition for exact + semantic lookup,
    // instead of flattening a definition list into undifferentiated prose.
    pushCleanedBlock(state, `${entry.term}: ${entry.definition}`, group);
  }
}

// ─── Preformatted / code blocks ──────────────────────────────────────────────

function codeLanguageFromClass(className: string | undefined): string | undefined {
  if (className === undefined) return undefined;
  for (const token of className.toLowerCase().split(/\s+/u)) {
    if (token.startsWith("language-")) return token.slice("language-".length) || undefined;
    if (token.startsWith("lang-")) return token.slice("lang-".length) || undefined;
  }
  return undefined;
}

function firstCodeLanguage(elementHtml: string): string | undefined {
  const at = elementHtml.toLowerCase().indexOf("<code");
  if (at < 0) return undefined;
  const gt = elementHtml.indexOf(">", at);
  if (gt < 0) return undefined;
  return codeLanguageFromClass(tagAttribute(elementHtml.slice(at, gt + 1), "class"));
}

function appendPreformatted(state: ScanState, elementHtml: string, tag: Tag): void {
  // Verbatim inner text: tags stripped and entities decoded, but whitespace NOT collapsed so code
  // indentation and exact identifiers survive for lexical retrieval.
  const code = fragmentTextRaw(elementHtml);
  const language =
    codeLanguageFromClass(tagAttribute(tag.raw, "class")) ?? firstCodeLanguage(elementHtml);
  pushVerbatimBlock(state, language !== undefined ? `Code (${language}):\n${code}` : code);
}

// ─── Frameset navigation links ───────────────────────────────────────────────

// True when `value` starts with a URI scheme (`letter [letter|digit|+|-|.]* ":"`) that is NOT
// `http`/`https`. Catches `javascript:`, `data:`, `vbscript:`, etc. — schemes that carry an
// executable or arbitrary-payload body and have no `://` to trip the old (bypassed) check.
function hasUnsafeScheme(value: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):/iu.exec(value);
  if (match?.[1] === undefined) return false;
  const scheme = match[1].toLowerCase();
  return scheme !== "http" && scheme !== "https";
}

// Reduce a frame `src` to a body-safe navigation reference: drop query/fragment, and for an
// absolute URL keep only the path so no host, credentials, or token can surface in evidence. Any
// non-http(s) scheme (javascript:, data:, vbscript:, …) is rejected outright rather than
// forwarded verbatim — a scheme body may carry an arbitrary attacker-controlled payload. A
// protocol-relative target (`//host/path`, valid and browser-resolvable HTML with no scheme and no
// literal `://`) carries a host exactly like `scheme://host/path` does and must have it stripped
// the same way — it has neither an unsafe scheme nor a `://` substring, so both of those checks
// alone would fall through and forward the host verbatim.
// Where the host substring begins: right after `://` when present, right after a leading `//`
// for a protocol-relative target, or -1 when neither applies (no host to strip).
function resolveHostStart(trimmed: string, schemeAt: number): number {
  if (schemeAt >= 0) return schemeAt + 3;
  if (trimmed.startsWith("//")) return 2;
  return -1;
}

function redactFrameTarget(src: string): string | undefined {
  const base = src.split(/[?#]/u)[0] ?? "";
  const trimmed = base.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || trimmed.includes("\0")) return undefined;
  if (hasUnsafeScheme(trimmed)) return undefined;
  const schemeAt = trimmed.indexOf("://");
  const hostStart = resolveHostStart(trimmed, schemeAt);
  if (hostStart < 0) return trimmed;
  const afterHost = trimmed.slice(hostStart);
  const slash = afterHost.indexOf("/");
  return slash < 0 ? "/" : afterHost.slice(slash);
}

function appendFrameLink(state: ScanState, tag: Tag): void {
  const src = tagAttribute(tag.raw, "src");
  if (src === undefined) return;
  const target = redactFrameTarget(src);
  if (target === undefined) return;
  // Surface the frameset table-of-contents targets as discoverable references. The parser stays
  // pure — it never fetches or follows the link; egress remains the crawler's injected port.
  pushCleanedBlock(state, `Frame: ${target}`);
}

// ─── Title + declared charset ────────────────────────────────────────────────

// Finds the real `<title>` element by walking tags with the same event scanner the body uses,
// skipping `<script>`/`<style>`/`<noscript>` subtrees along the way — NOT a raw `indexOf` over
// undifferentiated document text. A raw substring search would accept a `<title>...</title>`-
// shaped literal sitting inside an earlier `<script>` (e.g. a client-side widget building HTML
// strings) as if it were the document's real title.
// Extracts the text of an already-located open `<title>` tag: undefined when the closing tag is
// missing (unterminated element) or the decoded text is empty.
function titleFromOpenTag(rawText: string, textLower: string, tag: Tag): string | undefined {
  const close = textLower.indexOf("</title", tag.end);
  if (close < 0) return undefined;
  const title = htmlFragmentText(rawText.slice(tag.end, close));
  return title.length === 0 ? undefined : title;
}

function readDocumentTitle(rawText: string): string | undefined {
  const textLower = rawText.toLowerCase();
  let cursor = 0;
  while (cursor < rawText.length) {
    const event = nextEvent(rawText, cursor);
    if (event.kind === "eof") return undefined;
    if (event.kind !== "tag") {
      cursor = event.next;
      continue;
    }
    const { tag } = event;
    if (RAW_TEXT_TAGS.has(tag.name) && tag.kind === "open") {
      cursor = skipRawText(rawText, textLower, tag.name, tag.end);
      continue;
    }
    if (tag.name === "title" && tag.kind === "open") {
      return titleFromOpenTag(rawText, textLower, tag);
    }
    cursor = event.next;
  }
  return undefined;
}

function isCharsetLabelChar(code: number): boolean {
  return (
    isNameChar(code) || code === 0x2e /* . */ || code === 0x3a /* : */ || code === 0x5f
  ); /* _ */
}

// Advance past `=`, whitespace, and an opening quote to the first character of the charset value.
function skipToCharsetValue(head: string, from: number): number {
  let i = from;
  while (i < head.length && (head.codePointAt(i) === 0x3d || (head.codePointAt(i) ?? 0) <= 0x20))
    i += 1;
  if (i < head.length && (head.codePointAt(i) === 0x22 || head.codePointAt(i) === 0x27)) i += 1;
  return i;
}

// Real charset names (utf-8, windows-1252, shift_jis, iso-8859-1, …) are well under this length.
// Capping here keeps the label bounded everywhere it is used downstream — including the
// HTML_CHARSET_MISMATCH diagnostic message — instead of embedding an arbitrarily long,
// document-controlled value (the head window is scanned up to 2048 bytes).
const MAX_CHARSET_LABEL_LENGTH = 64;

// Extract a charset label from a single `<meta ...>` tag's raw text (bounded input — never the
// whole head window), so ordinary body prose containing the word "charset" cannot be mistaken for
// a declaration.
function charsetFromMetaTag(metaTagLower: string): string | undefined {
  const at = metaTagLower.indexOf("charset");
  if (at < 0) return undefined;
  const start = skipToCharsetValue(metaTagLower, at + "charset".length);
  let end = start;
  while (
    end < metaTagLower.length &&
    end - start < MAX_CHARSET_LABEL_LENGTH &&
    isCharsetLabelChar(metaTagLower.codePointAt(end) ?? 0)
  ) {
    end += 1;
  }
  const label = metaTagLower.slice(start, end);
  return label.length === 0 ? undefined : label;
}

// Read a declared `<meta charset>` / `http-equiv` charset from the head bytes. Scoped to actual
// `<meta ...>` tags (found via the same quote-aware `findTagEnd` the body scanner uses — no
// tag-filter regex, preserving the CodeQL posture) instead of a bare `indexOf("charset")` over
// undifferentiated text, so ordinary prose that happens to contain the word "charset" cannot
// trigger a false HTML_CHARSET_MISMATCH diagnostic.
function readMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 2048));
  const headLower = head.toLowerCase();
  let cursor = 0;
  while (cursor < head.length) {
    const lt = headLower.indexOf("<meta", cursor);
    if (lt < 0) return undefined;
    const gt = findTagEnd(head, lt + 5);
    if (gt < 0) return undefined;
    const label = charsetFromMetaTag(headLower.slice(lt, gt + 1));
    if (label !== undefined) return label;
    cursor = gt + 1;
  }
  return undefined;
}

function normalizeCharset(label: string): string {
  const key = label.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (key === "utf8") return "utf-8";
  if (key === "utf16" || key === "utf16le" || key === "utf16be" || key === "ucs2") return "utf-16";
  if (key === "latin1" || key === "iso88591" || key === "cp1252" || key === "windows1252") {
    return "windows-1252";
  }
  return key;
}

// Emit a body-safe warning when the declared charset disagrees with the byte-shape codec actually
// used, so a legacy-encoding manual degrades predictably with a diagnostic instead of silently
// corrupting content. The message carries only normalized codec LABELS, never document bytes.
function charsetMismatchDiagnostic(
  declared: string | undefined,
  usedCodec: string,
  documentId: DocumentId,
): ParserDiagnostic | undefined {
  if (declared === undefined) return undefined;
  const declaredFamily = normalizeCharset(declared);
  // A repaired document is UTF-8 with stray bytes: its codec family is UTF-8.
  const usedFamily = usedCodec.includes("+") ? "utf-8" : normalizeCharset(usedCodec);
  if (declaredFamily === usedFamily) return undefined;
  return diagnostic(
    "HTML_CHARSET_MISMATCH",
    `declared charset '${declaredFamily}' differs from decoded byte shape '${usedFamily}'; decoded using byte-shape detection`,
    documentId,
    "warning",
  );
}

// A fragment identifier is a safe slug — never a path, scheme, or quoted string (see the
// `anchorId` contract comment in keiko-contracts/local-knowledge-records.ts). This is a positive
// allowlist (letters, digits, `-`, `_`, `.`, `:`) rather than a negative blocklist so a
// scheme-like prefix without `//` (e.g. `javascript:alert(1)`), a path (`../../etc/passwd`), or an
// embedded quote cannot slip through as a "close enough" slug.
function isAnchorSlugChar(code: number): boolean {
  return (
    isAlpha(code) ||
    (code >= 0x30 && code <= 0x39) /* 0-9 */ ||
    code === 0x2d /* - */ ||
    code === 0x5f /* _ */ ||
    code === 0x2e /* . */ ||
    code === 0x3a /* : */
  );
}

function isAnchorSlug(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!isAnchorSlugChar(value.codePointAt(i) ?? 0)) return false;
  }
  return true;
}

function anchorFromTag(tag: Tag): string | undefined {
  const raw = tagAttribute(tag.raw, "id") ?? tagAttribute(tag.raw, "name");
  if (raw === undefined) return undefined;
  const value = raw.startsWith("#") ? raw.slice(1) : raw;
  return isAnchorSlug(value) ? value : undefined;
}

function openBlock(state: ScanState, at: number, hasText: boolean): void {
  if (state.pendingBlockStart === null) {
    state.pendingBlockStart = at;
    state.blockText = "";
  }
  if (hasText) state.pendingBlockHasText = true;
}

function handleHeadingOpen(state: ScanState, tag: Tag, level: number): number {
  // Flush the previous section's block first (it still owns the previous anchor), then adopt this
  // heading's fragment anchor so blocks under it can deep-link to the exact manual section.
  flushBlock(state, tag.start);
  state.currentAnchor = anchorFromTag(tag);
  state.pendingHeadingLabel = "";
  state.pendingHeadingLevel = level;
  return tag.end;
}

// Closes the heading being read: its collapsed label joins the heading path AND the text as a block
// of its own, owned by the path it opens (so a Markdown `## Title` line and an `<h2>` read alike and
// the heading's words are searchable). #2906 KEIKO-0775: whitespace is collapsed once, at close time,
// so source indentation and inline-tag gaps never survive into the label.
function finishHeading(state: ScanState): void {
  if (state.pendingHeadingLabel === null) return;
  const label = collapseWhitespace(state.pendingHeadingLabel).trim();
  if (label.length > 0 && state.pendingHeadingLevel > 0) {
    pushHeading(state.heading, state.pendingHeadingLevel, label);
    pushRenderedBlock(state, label);
  }
  state.pendingHeadingLabel = null;
  state.pendingHeadingLevel = 0;
}

function handleHeadingClose(state: ScanState, tag: Tag): number {
  finishHeading(state);
  state.pendingBlockStart = tag.end;
  return tag.end;
}

// Inline text goes to the heading being read or to the current block.
function appendInlineText(state: ScanState, at: number, text: string, hasText: boolean): void {
  if (state.pendingHeadingLabel !== null) {
    state.pendingHeadingLabel += text;
    return;
  }
  openBlock(state, at, hasText);
  // Accumulate only inter-tag text runs — inline tag literals (<b>, <a …>) are never part of
  // a run, so the cleaned projection is tag-free by construction.
  state.blockText += text;
}

function appendTextRun(state: ScanState, from: number, to: number): void {
  if (from >= to) return;
  appendInlineText(
    state,
    from,
    visibleText(state.text.slice(from, to)),
    !isWhitespaceOnly(state.text, from, to),
  );
}

// Elements whose whole subtree is skipped in the body scan and re-rendered structurally: table
// rows, definition lists, verbatim code, and (metadata) `<title>` captured separately. Returns the
// cursor past the element, or `undefined` when `tag` is not one of these.
function handleStructuralTag(state: ScanState, tag: Tag): number | undefined {
  if (tag.kind !== "open") return undefined;
  if (METADATA_TAGS.has(tag.name)) {
    flushBlock(state, tag.start);
    return skipElement(state.text, state.textLower, tag.name, tag.end);
  }
  if (tag.name === "table" || tag.name === "dl" || tag.name === "pre") {
    flushBlock(state, tag.start);
    state.pendingMarker = undefined;
    // `<table>` and `<dl>` can legitimately nest same-named children (a cell with a sub-table, a
    // `<dd>` with a nested `<dl>`); `<pre>` cannot, so the simpler raw-text-style skip is enough.
    const end =
      tag.name === "pre"
        ? skipElement(state.text, state.textLower, tag.name, tag.end)
        : skipNestableElement(state.text, state.textLower, tag.name, tag.end);
    const elementHtml = state.text.slice(tag.start, end);
    if (tag.name === "table") appendTableRows(state, elementHtml);
    else if (tag.name === "dl") appendDefinitionList(state, elementHtml);
    else appendPreformatted(state, elementHtml, tag);
    return end;
  }
  return undefined;
}

// A subtree that is not document text: a hidden element or page furniture. Page furniture named
// only by a class/id token, and any hidden element, is removed only when its end tag exists and it
// holds at most {@link MAX_REMOVABLE_SHARE} of the document: a wrapper around the real content is
// content, whatever it is called, and an element that never closes would otherwise take the rest
// of the page with it. Returns the cursor past the subtree, or `undefined` to keep it.
function handleExcludedSubtree(state: ScanState, tag: Tag): number | undefined {
  const verdict = classifySubtree(tag);
  if (verdict === "none") return undefined;
  const unconditional = verdict === "boilerplate-tag";
  if (!unconditional && state.exclusionBudget <= 0) return undefined;
  const bounds = findNestableElementEnd(state.text, state.textLower, tag.name, tag.end);
  state.exclusionBudget -= bounds.elementEnd - tag.start;
  const closed = bounds.contentEnd < state.text.length;
  const small = (bounds.elementEnd - tag.start) / state.text.length <= MAX_REMOVABLE_SHARE;
  if (!unconditional && !(closed && small)) return undefined;
  flushBlock(state, tag.start);
  if (verdict === "hidden") state.excludedHidden += 1;
  else state.excludedBoilerplate += 1;
  return bounds.elementEnd;
}

// Tags whose subtree is dropped from the body flow (raw-text/script, boilerplate, hidden) or
// surfaced as a navigation reference (frame). Returns the cursor past the tag, or `undefined` when
// not handled.
function handleDropTag(state: ScanState, tag: Tag): number | undefined {
  if (RAW_TEXT_TAGS.has(tag.name) && tag.kind === "open") {
    // Terminate any in-progress block at the tag boundary so the raw bytes never appear in
    // the unit stream. Skip past `</script>` (etc.); the next text run reopens a block.
    flushBlock(state, tag.start);
    return skipRawText(state.text, state.textLower, tag.name, tag.end);
  }
  const excluded = handleExcludedSubtree(state, tag);
  if (excluded !== undefined) return excluded;
  if (FRAME_TAGS.has(tag.name) && tag.kind !== "close") {
    appendFrameLink(state, tag);
    return tag.end;
  }
  return undefined;
}

function handleHeading(state: ScanState, tag: Tag): number | undefined {
  const level = headingLevel(tag.name);
  if (level > 0 && tag.kind === "open") return handleHeadingOpen(state, tag, level);
  if (level > 0 && tag.kind === "close") return handleHeadingClose(state, tag);
  return undefined;
}

function appendImageAlt(state: ScanState, tag: Tag): void {
  const alt = visibleText(parseTagAttributes(tag.raw).get("alt") ?? "").trim();
  if (alt.length > 0) appendInlineText(state, tag.start, ` ${alt} `, true);
}

function enterList(state: ScanState, tag: Tag): void {
  if (tag.kind === "open") state.lists.push({ ordered: tag.name === "ol", count: 0 });
  else if (tag.kind === "close") state.lists.pop();
}

// The marker of a list item: `- ` or its number, indented two spaces per enclosing list, so the
// structure of a list survives in the plain text.
function listItemMarker(state: ScanState): string {
  const list = state.lists.at(-1);
  if (list !== undefined) list.count += 1;
  const indent = "  ".repeat(Math.max(0, state.lists.length - 1));
  const marker = list?.ordered === true ? `${String(list.count)}. ` : "- ";
  return `${indent}${marker}`;
}

// Block-level elements end the current block, so neighbouring paragraphs, items and lines are
// separate lines of text. Inline elements are not listed and stay inside the running text.
function handleFlowTag(state: ScanState, tag: Tag): number | undefined {
  if (tag.name === "img" && tag.kind !== "close") {
    appendImageAlt(state, tag);
    return tag.end;
  }
  if (tag.name === "br" && state.pendingHeadingLabel !== null) {
    state.pendingHeadingLabel += " ";
    return tag.end;
  }
  if (!BLOCK_TAGS.has(tag.name)) return undefined;
  if (tag.name === "ul" || tag.name === "ol") enterList(state, tag);
  flushBlock(state, tag.start);
  if (tag.name === "li")
    state.pendingMarker = tag.kind === "open" ? listItemMarker(state) : undefined;
  return tag.end;
}

function handleTag(state: ScanState, tag: Tag): number {
  return (
    handleDropTag(state, tag) ??
    handleStructuralTag(state, tag) ??
    handleHeading(state, tag) ??
    handleFlowTag(state, tag) ??
    tag.end
  );
}

function step(state: ScanState, cursor: number): number {
  const event = nextEvent(state.text, cursor);
  if (event.kind === "eof") {
    flushBlock(state, state.text.length);
    return state.text.length;
  }
  if (event.kind === "text") {
    appendTextRun(state, event.start, event.end);
    return event.next;
  }
  if (event.kind === "marker") return event.next;
  return handleTag(state, event.tag);
}

// Cooperative deadline granularity for the top-level scan. `flushBlock`/`pushRenderedBlock` check
// `shouldStop` only when a block is EMITTED, so an input engineered to produce very few blocks while
// requiring a lot of scanning (one enormous text run, a huge unterminated element, thousands of
// attribute-only tags) could scan far past `timeoutMs` before any limit was consulted. The scan loop
// therefore re-checks every SCAN_DEADLINE_CHECK_STEPS steps via the shared `recordScanLimit`. The
// interval is large enough that the added `options.now()` calls are immaterial next to the per-step
// scanning work, and small enough that the deadline is honoured promptly on a block-free document.
const SCAN_DEADLINE_CHECK_STEPS = 4096;

// Body-free count of what was left out: neither the names nor the text of the subtrees.
function exclusionDiagnostics(state: ScanState): readonly ParserDiagnostic[] {
  if (state.excludedBoilerplate === 0 && state.excludedHidden === 0) return [];
  return [
    diagnostic(
      "HTML_CONTENT_EXCLUDED",
      `excluded ${String(state.excludedBoilerplate)} boilerplate and ${String(state.excludedHidden)} hidden subtree(s) from the text`,
      state.input.documentId,
      "info",
    ),
  ];
}

function emitHtml(rawText: string, input: ParserSelectionInput, options: ParserOptions): Emission {
  // Read the title from the FULL document (before <main> narrowing drops the head) so a manual's
  // name is preserved as a searchable block even when it lives in <head>.
  const documentTitle = readDocumentTitle(rawText);
  const text = selectMainContent(rawText);
  const state: ScanState = {
    text,
    textLower: text.toLowerCase(),
    input,
    options,
    startedAt: options.now(),
    units: [],
    diagnostics: [],
    heading: { stack: [] },
    pendingBlockStart: null,
    pendingBlockHasText: false,
    pendingHeadingLabel: null,
    pendingHeadingLevel: 0,
    currentAnchor: undefined,
    stopped: false,
    lists: [],
    pendingMarker: undefined,
    excludedBoilerplate: 0,
    excludedHidden: 0,
    exclusionBudget: text.length * EXCLUSION_BUDGET_FACTOR,
    tableCount: 0,
    blockGroup: undefined,
    blockGroupCount: 0,
    blockText: "",
    cleanedParts: [],
    cleanedOffset: 0,
  };
  if (documentTitle !== undefined) pushCleanedBlock(state, documentTitle);
  let cursor = 0;
  let steps = 0;
  while (cursor < text.length && !state.stopped) {
    cursor = step(state, cursor);
    steps += 1;
    if (steps % SCAN_DEADLINE_CHECK_STEPS === 0) recordScanLimit(state);
  }
  flushBlock(state, text.length);
  return {
    units: state.units,
    diagnostics: [...exclusionDiagnostics(state), ...state.diagnostics],
    normalizedText: state.cleanedParts.join(""),
  };
}

export const htmlParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => isHtml(input),
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    const refusal = textInputRefusal(htmlParser.capability, input, options);
    if (refusal !== undefined) return refusal;
    // Cross-check any declared <meta charset> against the byte-shape decode: the declared charset
    // only steers the fallback codec (strict UTF-8/BOM still win), and a genuine disagreement is
    // surfaced as a body-safe HTML_CHARSET_MISMATCH warning rather than silently corrupting text.
    const declaredCharset = readMetaCharset(input.bytes);
    const decoded = decodeBytes(input.bytes, declaredCharset);
    const emission = emitHtml(decoded.text, input, options);
    const charsetDiag = charsetMismatchDiagnostic(declaredCharset, decoded.codec, input.documentId);
    const repairDiag =
      decoded.repairedBytes === undefined
        ? undefined
        : encodingDiagnostic(decoded, input.documentId);
    const diagnostics = [
      ...(charsetDiag === undefined ? [] : [charsetDiag]),
      ...(repairDiag === undefined ? [] : [repairDiag]),
      ...emission.diagnostics,
    ];
    const result: InternalParserResult = {
      ...emptyResult(htmlParser.capability, input.documentId, options, diagnostics, emission.units),
      // GRD-003: persist the cleaned, tag/script/style-free projection so extract.ts NEVER
      // falls back to raw bytes (which carried <script> bodies + embedded secrets).
      normalizedText: emission.normalizedText,
    };
    return result;
  },
});
