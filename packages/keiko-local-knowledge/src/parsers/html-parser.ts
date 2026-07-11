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
  decodeXmlEntities,
  diagnostic,
  emptyResult,
  oversizeDiagnostic,
  readAttribute,
  shouldStop,
} from "./_internal.js";
import type { DocumentId, ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts";
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
    const code = value.charCodeAt(i);
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
const PARSER_VERSION = "1";

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
const BOILERPLATE_HINTS: readonly string[] = [
  "cookie",
  "consent",
  "banner",
  "navbar",
  "breadcrumb",
  "sidebar",
  "footer",
];

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
  while (i < text.length && isNameChar(text.charCodeAt(i))) i += 1;
  return { name: text.slice(from, i).toLowerCase(), after: i };
}

// Returns the next tag starting at or after `from`. Skips comments, CDATA, and DOCTYPE.
function skipSpecialMarker(text: string, after: number): number | null {
  if (text.startsWith("!--", after)) {
    const close = text.indexOf("-->", after + 3);
    return close === -1 ? text.length : close + 3;
  }
  const ch = text.charCodeAt(after);
  if (ch === 0x21 /* ! */ || ch === 0x3f /* ? */) {
    const gt = text.indexOf(">", after);
    return gt === -1 ? text.length : gt + 1;
  }
  return null;
}

// Quote-aware scan for a tag's terminating `>`. A single- or double-quoted attribute value may
// contain a literal `>` (e.g. `title="Section > Details"`); a bare `indexOf(">", from)` would
// mis-terminate the tag there, corrupting `tag.raw` and desynchronizing the scanner cursor for
// every subsequent event. This stays a single-pass character scan (no regex) so the CodeQL
// `js/bad-tag-filter` posture is preserved.
function findQuotedTagEnd(text: string, from: number): number {
  let quote = 0; // 0 = not in a quote, else the quote char code (0x22 `"` or 0x27 `'`)
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
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
  const quoted = findQuotedTagEnd(text, from);
  if (quoted !== -1) return quoted;
  return text.indexOf(">", from);
}

function readTagAt(text: string, lt: number): Tag | null {
  const after = lt + 1;
  const isClose = text.charCodeAt(after) === 0x2f; /* / */
  const nameStart = isClose ? after + 1 : after;
  if (!isAlpha(text.charCodeAt(nameStart))) return null;
  const { name, after: afterName } = readTagName(text, nameStart);
  const gt = findTagEnd(text, afterName);
  if (gt === -1) return null;
  const selfClosing = !isClose && text.charCodeAt(gt - 1) === 0x2f;
  const kind: TagKind = isClose ? "close" : selfClosing ? "self-closing" : "open";
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

function isBoilerplateTag(tag: Tag): boolean {
  if (tag.kind !== "open") return false;
  if (BOILERPLATE_TAGS.has(tag.name)) return true;
  const raw = tag.raw.toLowerCase();
  if (tag.name === "header" && (raw.includes("nav") || raw.includes("banner"))) return true;
  if (tag.name !== "div" && tag.name !== "section") return false;
  return BOILERPLATE_HINTS.some((hint) => raw.includes(hint));
}

function selectMainContent(text: string): string {
  const lower = text.toLowerCase();
  const open = lower.indexOf("<main");
  if (open < 0) return text;
  const openEnd = text.indexOf(">", open);
  if (openEnd < 0) return text;
  const close = lower.indexOf("</main", openEnd + 1);
  if (close < 0) return text.slice(open);
  const closeEnd = text.indexOf(">", close);
  return text.slice(open, closeEnd < 0 ? text.length : closeEnd + 1);
}

// ─── Heading stack ───────────────────────────────────────────────────────────

function headingLevel(name: string): number {
  if (name.length !== 2 || name.charCodeAt(0) !== 0x68 /* h */) return 0;
  const code = name.charCodeAt(1);
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
  // GRD-003: build a cleaned, tag/script/style-free normalizedText projection and re-base
  // unit offsets onto it (mirrors the xlsx parser). The raw bytes — including <script> bodies
  // and embedded secrets — must NEVER become the persisted normalized_text / LLM excerpt.
  blockText: string; // accumulator for the current block's visible text
  readonly cleanedParts: string[]; // joined into the final normalizedText
  cleanedOffset: number; // running length of cleanedParts.join("")
}

function isWhitespaceOnly(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

function resetBlock(state: ScanState): void {
  state.pendingBlockStart = null;
  state.pendingBlockHasText = false;
  state.blockText = "";
}

function flushBlock(state: ScanState, end: number): void {
  if (state.pendingBlockStart === null) return;
  if (end <= state.pendingBlockStart || !state.pendingBlockHasText) {
    resetBlock(state);
    return;
  }
  const limit = shouldStop(state.startedAt, state.options, state.units.length);
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    state.diagnostics.push(diagnostic(limit.code, limit.message, state.input.documentId, "info"));
    state.stopped = true;
    resetBlock(state);
    return;
  }
  // Offsets index the CLEANED projection, not the raw HTML — so citation slices and chunk
  // spans never expose tags, <script>/<style> bodies, or embedded secrets.
  const cleaned = collapseWhitespace(state.blockText);
  if (cleaned.length === 0) {
    resetBlock(state);
    return;
  }
  if (state.cleanedParts.length > 0) {
    // Single newline separator between blocks (a gap not covered by any unit range).
    state.cleanedParts.push("\n");
    state.cleanedOffset += 1;
  }
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
function pushRenderedBlock(state: ScanState, rendered: string): void {
  if (rendered.length === 0) return;
  const limit = shouldStop(state.startedAt, state.options, state.units.length);
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    state.diagnostics.push(diagnostic(limit.code, limit.message, state.input.documentId, "info"));
    state.stopped = true;
    return;
  }
  if (state.cleanedParts.length > 0) {
    state.cleanedParts.push("\n");
    state.cleanedOffset += 1;
  }
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

function pushCleanedBlock(state: ScanState, text: string): void {
  pushRenderedBlock(state, collapseWhitespace(text));
}

// Verbatim variant for <pre>/<code> so code indentation, line breaks, and exact identifiers are
// preserved for lexical retrieval instead of being flattened by `collapseWhitespace`. Only
// leading/trailing blank lines are trimmed; interior whitespace is kept byte-for-byte.
function pushVerbatimBlock(state: ScanState, text: string): void {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 0x0a) start += 1;
  while (end > start && text.charCodeAt(end - 1) === 0x0a) end -= 1;
  pushRenderedBlock(state, text.slice(start, end));
}

// Shared by <pre>/<code> verbatim capture, <dl> definitions, <table> cells, and <title>: walks an
// already-sliced element-HTML fragment and returns its visible text. MUST skip any nested
// `<script>`/`<style>`/`<noscript>` subtree the same way the top-level body scanner does — a
// script/style body must never survive tag-stripping into the persisted normalizedText (GRD-003),
// regardless of which container element it happens to be nested inside.
function fragmentTextRaw(fragment: string): string {
  const fragmentLower = fragment.toLowerCase();
  let out = "";
  let cursor = 0;
  while (cursor < fragment.length) {
    const event = nextEvent(fragment, cursor);
    if (event.kind === "eof") break;
    if (event.kind === "text") {
      out += fragment.slice(event.start, event.end);
      cursor = event.next;
      continue;
    }
    if (event.kind === "tag" && RAW_TEXT_TAGS.has(event.tag.name) && event.tag.kind === "open") {
      cursor = skipRawText(fragment, fragmentLower, event.tag.name, event.tag.end);
      continue;
    }
    cursor = event.next;
  }
  return decodeXmlEntities(out);
}

function htmlFragmentText(fragment: string): string {
  return fragmentTextRaw(fragment).trim();
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

const ROW_TAGS: ReadonlySet<string> = new Set(["tr"]);
const CELL_TAGS: ReadonlySet<string> = new Set(["td", "th"]);

// Bounds a `colspan`/`rowspan` attribute value to a sane positive integer so a malformed or
// hostile table (e.g. `colspan="999999999"`) cannot force an unbounded column-expansion loop.
const MAX_CELL_SPAN = 1000;

function readSpanCount(tagRaw: string, attribute: string): number {
  const raw = readAttribute(tagRaw, attribute);
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
  return extractElements(rowHtml, CELL_TAGS).map((cell) => ({
    header: cell.name === "th",
    text: htmlFragmentText(cell.innerHtml),
    colspan: readSpanCount(cell.tagRaw, "colspan"),
    rowspan: readSpanCount(cell.tagRaw, "rowspan"),
  }));
}

// Repeats each cell `colspan` times so a spanning `<th>`/`<td>` occupies one array slot per
// logical column it covers — otherwise header-to-value zipping (`appendTableRows`) stays purely
// positional and misaligns every column from a spanning cell onward.
function expandRowByColspan(row: readonly TableCell[]): readonly TableCell[] {
  const expanded: TableCell[] = [];
  for (const cell of row) {
    for (let i = 0; i < cell.colspan; i += 1) expanded.push(cell);
  }
  return expanded;
}

function normalizeHeaders(headers: readonly string[], count: number): readonly string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: count }, (_, index) => {
    const raw = headers[index] ?? "";
    const base = raw.trim().length > 0 ? raw.trim() : `Column ${String(index + 1)}`;
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
function appendTableCaption(state: ScanState, tableHtml: string): void {
  const caption = extractElements(tableHtml, CAPTION_TAGS)[0];
  if (caption === undefined) return;
  const text = htmlFragmentText(caption.innerHtml);
  if (text.length === 0) return;
  pushCleanedBlock(state, `Table caption: ${text}`);
}

// A header cell's `rowspan` is meant to carry that header down across the spanned data rows below
// it — this parser does not track per-column carry-forward state across rows, so a spanning header
// only labels its own row. Surface a body-safe diagnostic instead of silently misaligning the
// spanned rows' headers.
function warnIfHeaderRowspanUnsupported(state: ScanState, headerRow: readonly TableCell[]): void {
  if (!headerRow.some((cell) => cell.header && cell.rowspan > 1)) return;
  state.diagnostics.push(
    diagnostic(
      "HTML_TABLE_SPAN_UNSUPPORTED",
      "table header cell uses rowspan > 1; header association is not carried into the spanned rows below it",
      state.input.documentId,
      "warning",
    ),
  );
}

function appendTableRows(state: ScanState, tableHtml: string): void {
  appendTableCaption(state, tableHtml);
  const rows = extractElements(tableHtml, ROW_TAGS)
    .map((row) => tableCells(row.innerHtml))
    .map(expandRowByColspan);
  if (rows.length === 0) return;
  const first = rows[0] ?? [];
  const headerIsSchema =
    rows.length > 1 && first.some((cell) => cell.header || /[A-Za-z_]/u.test(cell.text));
  if (headerIsSchema) warnIfHeaderRowspanUnsupported(state, first);
  const maxCells = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const headers = headerIsSchema
    ? normalizeHeaders(
        first.map((cell) => cell.text),
        maxCells,
      )
    : normalizeHeaders([], maxCells);
  const dataRows = headerIsSchema ? rows.slice(1) : rows;
  for (const row of dataRows) {
    if (state.stopped) return;
    const text = row
      .map((cell, index) => `${headers[index] ?? `Column ${String(index + 1)}`}=${cell.text}`)
      .join(" | ");
    pushCleanedBlock(state, `Table: ${text}`);
  }
}

// ─── Definition lists ────────────────────────────────────────────────────────

// Pair each `<dt>` term with its following `<dd>` definition(s). Mirrors the table extractor:
// Depth-aware TOP-LEVEL `<dt>`/`<dd>` walk via `extractElements` (not a non-greedy regex — a
// `<dd>` containing its own nested `<dl>` would otherwise truncate at the INNER list's first
// `</dd>`/`</dt>`, silently dropping every sibling term/definition that follows the nested list).
const DEFINITION_TAGS: ReadonlySet<string> = new Set(["dt", "dd"]);

function definitionEntries(
  dlHtml: string,
): readonly { readonly term: string; readonly definition: string }[] {
  const entries: { term: string; definition: string }[] = [];
  let term: string | undefined;
  for (const element of extractElements(dlHtml, DEFINITION_TAGS)) {
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
  for (const entry of definitionEntries(dlHtml)) {
    if (state.stopped) return;
    // "Term: definition" keeps the term attached to its definition for exact + semantic lookup,
    // instead of flattening a definition list into undifferentiated prose.
    pushCleanedBlock(state, `${entry.term}: ${entry.definition}`);
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
  return codeLanguageFromClass(readAttribute(elementHtml.slice(at, gt + 1), "class"));
}

function appendPreformatted(state: ScanState, elementHtml: string, tag: Tag): void {
  // Verbatim inner text: tags stripped and entities decoded, but whitespace NOT collapsed so code
  // indentation and exact identifiers survive for lexical retrieval.
  const code = fragmentTextRaw(elementHtml);
  const language =
    codeLanguageFromClass(readAttribute(tag.raw, "class")) ?? firstCodeLanguage(elementHtml);
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
function redactFrameTarget(src: string): string | undefined {
  const base = src.split(/[?#]/u)[0] ?? "";
  const trimmed = base.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || trimmed.includes("\0")) return undefined;
  if (hasUnsafeScheme(trimmed)) return undefined;
  const schemeAt = trimmed.indexOf("://");
  const hostStart = schemeAt >= 0 ? schemeAt + 3 : trimmed.startsWith("//") ? 2 : -1;
  if (hostStart < 0) return trimmed;
  const afterHost = trimmed.slice(hostStart);
  const slash = afterHost.indexOf("/");
  return slash < 0 ? "/" : afterHost.slice(slash);
}

function appendFrameLink(state: ScanState, tag: Tag): void {
  const src = readAttribute(tag.raw, "src");
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
  while (i < head.length && (head.charCodeAt(i) === 0x3d || head.charCodeAt(i) <= 0x20)) i += 1;
  if (i < head.length && (head.charCodeAt(i) === 0x22 || head.charCodeAt(i) === 0x27)) i += 1;
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
    isCharsetLabelChar(metaTagLower.charCodeAt(end))
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
  if (declaredFamily === normalizeCharset(usedCodec)) return undefined;
  return diagnostic(
    "HTML_CHARSET_MISMATCH",
    `declared charset '${declaredFamily}' differs from decoded byte shape '${normalizeCharset(usedCodec)}'; decoded using byte-shape detection`,
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
    if (!isAnchorSlugChar(value.charCodeAt(i))) return false;
  }
  return true;
}

function anchorFromTag(tag: Tag): string | undefined {
  const raw = readAttribute(tag.raw, "id") ?? readAttribute(tag.raw, "name");
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

function handleHeadingClose(state: ScanState, tag: Tag): number {
  const label = (state.pendingHeadingLabel ?? "").trim();
  if (label.length > 0 && state.pendingHeadingLevel > 0) {
    pushHeading(state.heading, state.pendingHeadingLevel, label);
  }
  state.pendingHeadingLabel = null;
  state.pendingHeadingLevel = 0;
  state.pendingBlockStart = tag.end;
  return tag.end;
}

function appendTextRun(state: ScanState, from: number, to: number): void {
  if (from >= to) return;
  if (state.pendingHeadingLabel !== null) {
    state.pendingHeadingLabel += state.text.slice(from, to);
    return;
  }
  openBlock(state, from, !isWhitespaceOnly(state.text, from, to));
  // Accumulate only inter-tag text runs — inline tag literals (<b>, <a …>) are never part of
  // a run, so the cleaned projection is tag-free by construction.
  state.blockText += state.text.slice(from, to);
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

// Tags whose subtree is dropped from the body flow (raw-text/script, boilerplate) or surfaced as a
// navigation reference (frame). Returns the cursor past the tag, or `undefined` when not handled.
function handleDropTag(state: ScanState, tag: Tag): number | undefined {
  if (RAW_TEXT_TAGS.has(tag.name) && tag.kind === "open") {
    // Terminate any in-progress block at the tag boundary so the raw bytes never appear in
    // the unit stream. Skip past `</script>` (etc.); the next text run reopens a block.
    flushBlock(state, tag.start);
    return skipRawText(state.text, state.textLower, tag.name, tag.end);
  }
  if (isBoilerplateTag(tag)) {
    flushBlock(state, tag.start);
    return skipElement(state.text, state.textLower, tag.name, tag.end);
  }
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

function handleTag(state: ScanState, tag: Tag): number {
  return (
    handleDropTag(state, tag) ??
    handleStructuralTag(state, tag) ??
    handleHeading(state, tag) ??
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
    blockText: "",
    cleanedParts: [],
    cleanedOffset: 0,
  };
  if (documentTitle !== undefined) pushCleanedBlock(state, documentTitle);
  let cursor = 0;
  while (cursor < text.length && !state.stopped) {
    cursor = step(state, cursor);
  }
  flushBlock(state, text.length);
  return {
    units: state.units,
    diagnostics: state.diagnostics,
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
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(htmlParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    // Cross-check any declared <meta charset> against the byte-shape decode: the declared charset
    // only steers the fallback codec (strict UTF-8/BOM still win), and a genuine disagreement is
    // surfaced as a body-safe HTML_CHARSET_MISMATCH warning rather than silently corrupting text.
    const declaredCharset = readMetaCharset(input.bytes);
    const decoded = decodeBytes(input.bytes, declaredCharset);
    const emission = emitHtml(decoded.text, input, options);
    const charsetDiag = charsetMismatchDiagnostic(declaredCharset, decoded.codec, input.documentId);
    const diagnostics =
      charsetDiag === undefined ? emission.diagnostics : [charsetDiag, ...emission.diagnostics];
    const result: InternalParserResult = {
      ...emptyResult(htmlParser.capability, input.documentId, options, diagnostics, emission.units),
      // GRD-003: persist the cleaned, tag/script/style-free projection so extract.ts NEVER
      // falls back to raw bytes (which carried <script> bodies + embedded secrets).
      normalizedText: emission.normalizedText,
    };
    return result;
  },
});
