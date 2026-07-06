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

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm", "xhtml"]);
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

function readTagAt(text: string, lt: number): Tag | null {
  const after = lt + 1;
  const isClose = text.charCodeAt(after) === 0x2f; /* / */
  const nameStart = isClose ? after + 1 : after;
  if (!isAlpha(text.charCodeAt(nameStart))) return null;
  const { name, after: afterName } = readTagName(text, nameStart);
  const gt = text.indexOf(">", afterName);
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

function skipElement(text: string, textLower: string, tagName: string, from: number): number {
  return skipRawText(text, textLower, tagName, from);
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

function fragmentTextRaw(fragment: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < fragment.length) {
    const event = nextEvent(fragment, cursor);
    if (event.kind === "eof") break;
    if (event.kind === "text") out += fragment.slice(event.start, event.end);
    cursor = event.next;
  }
  return decodeXmlEntities(out);
}

function htmlFragmentText(fragment: string): string {
  return fragmentTextRaw(fragment).trim();
}

function tableCells(
  rowHtml: string,
): readonly { readonly header: boolean; readonly text: string }[] {
  const cells: { header: boolean; text: string }[] = [];
  for (const match of rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    cells.push({
      header: match[1]?.toLowerCase() === "th",
      text: htmlFragmentText(match[2] ?? ""),
    });
  }
  return cells;
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

function appendTableRows(state: ScanState, tableHtml: string): void {
  const rows = Array.from(tableHtml.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)).map((match) =>
    tableCells(match[0]),
  );
  if (rows.length === 0) return;
  const first = rows[0] ?? [];
  const headerIsSchema =
    rows.length > 1 && first.some((cell) => cell.header || /[A-Za-z_]/u.test(cell.text));
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
// bounded `matchAll` over already-sliced element HTML, text flattened via `htmlFragmentText`.
function definitionEntries(
  dlHtml: string,
): readonly { readonly term: string; readonly definition: string }[] {
  const entries: { term: string; definition: string }[] = [];
  let term: string | undefined;
  for (const match of dlHtml.matchAll(/<(dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const kind = match[1]?.toLowerCase();
    const text = htmlFragmentText(match[2] ?? "");
    if (kind === "dt") {
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

// Reduce a frame `src` to a body-safe navigation reference: drop query/fragment, and for an
// absolute URL keep only the path so no host, credentials, or token can surface in evidence.
function redactFrameTarget(src: string): string | undefined {
  const base = src.split(/[?#]/u)[0] ?? "";
  const trimmed = base.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || trimmed.includes("\0")) return undefined;
  const schemeAt = trimmed.indexOf("://");
  if (schemeAt < 0) return trimmed;
  const afterHost = trimmed.slice(schemeAt + 3);
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

function readDocumentTitle(rawText: string): string | undefined {
  const lower = rawText.toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return undefined;
  const gt = rawText.indexOf(">", open);
  if (gt < 0) return undefined;
  const close = lower.indexOf("</title", gt + 1);
  if (close < 0) return undefined;
  const title = htmlFragmentText(rawText.slice(gt + 1, close));
  return title.length === 0 ? undefined : title;
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

// Read a declared `<meta charset>` / `http-equiv` charset from the head bytes using indexOf (no
// tag-filter regex — preserves the CodeQL posture). Returns a lowercase label or undefined.
function readMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 2048))
    .toLowerCase();
  const at = head.indexOf("charset");
  if (at < 0) return undefined;
  const start = skipToCharsetValue(head, at + "charset".length);
  let end = start;
  while (end < head.length && isCharsetLabelChar(head.charCodeAt(end))) end += 1;
  const label = head.slice(start, end);
  return label.length === 0 ? undefined : label;
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

function anchorFromTag(tag: Tag): string | undefined {
  const raw = readAttribute(tag.raw, "id") ?? readAttribute(tag.raw, "name");
  if (raw === undefined) return undefined;
  const value = raw.startsWith("#") ? raw.slice(1) : raw;
  if (value.length === 0 || value.length > 128 || value.includes("://") || value.includes("\0")) {
    return undefined;
  }
  return value;
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
    const end = skipElement(state.text, state.textLower, tag.name, tag.end);
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
