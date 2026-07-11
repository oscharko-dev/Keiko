// Deterministic ADF-to-plain-text conversion (Issue #2243, Epic #2238, ADR-0128 D5).
//
// Atlassian Document Format is versioned JSON (`{ "type": "doc", "version": 1 }`). This module is
// the recorded capability gap of Epic #2238: a pure, model-free, bounded converter from hostile
// ADF payloads to plain text suitable for the shared chunking/indexing lane. It is NOT an HTML
// renderer — the Jira document composer wraps the escaped text into the one shared HTML envelope
// downstream; no second HTML parsing path exists.
//
// Guarantees:
//   - Pure and deterministic: no IO, no clock, no randomness — the same input value always
//     produces byte-identical output (golden-tested per node type).
//   - Total over hostile input: unknown node types degrade to their concatenated child content,
//     malformed nodes render as empty text, and nothing throws.
//   - Bounded: a node budget (`ADF_TO_TEXT_MAX_NODES`), a nesting-depth cap
//     (`ADF_TO_TEXT_MAX_DEPTH`, which also terminates self-referencing object graphs that cannot
//     occur in JSON but can be constructed programmatically), and a hard output cap
//     (`ADF_TO_TEXT_MAX_OUTPUT_CHARS`, charged incrementally at every leaf emission AND enforced
//     as a final hard slice) make conversion linear in the node budget regardless of input shape.
//     Every cap trips a closed truncation reason on the outcome instead of failing.
//
// Rendering conventions (pinned by the golden tests): headings carry a conventional `#`-per-level
// prefix so heading levels survive into plain text; inline marks (strong/em/code/underline...)
// render as plain text — the only fence syntax emitted is the code-block fence, per the issue's
// "no markdown injection beyond code fences" rule; link marks render as `text (href)`; tables are
// linearized one row per line with ` | ` cell separators; nested lists indent by their marker
// width; task items carry `[x] `/`[ ] ` checkbox prefixes; media nodes render a readable
// placeholder. Unsupported doc versions degrade gracefully: content is still converted
// best-effort and the outcome reports the shape.

export const ADF_SUPPORTED_DOC_VERSION = 1;
export const ADF_TO_TEXT_MAX_DEPTH = 64;
export const ADF_TO_TEXT_MAX_NODES = 20_000;
export const ADF_TO_TEXT_MAX_OUTPUT_CHARS = 500_000;

// Bounded diagnostics: at most this many distinct unknown node-type names are reported, each
// clamped to this many characters (type names only — never node content).
const MAX_UNKNOWN_TYPE_NAMES = 20;
const MAX_UNKNOWN_TYPE_NAME_CHARS = 60;
const MAX_LINK_HREF_CHARS = 2_048;

// Deterministic, locale-independent string order (UTF-16 code units), matching the default
// `Array.prototype.sort()` order this converter has always produced. A locale-aware comparator
// (`String.localeCompare`) would make the output depend on the host locale and must not be used —
// the converter's output is required to be byte-identical for the same input.
function compareByCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export type AdfTruncationReason =
  "depth-exceeded" | "node-budget-exceeded" | "output-budget-exceeded";

// How the top-level input classified: a supported v1 doc, a doc with an unknown version
// (converted best-effort), or not a doc node at all (still converted best-effort when it looks
// like a node; empty otherwise).
export type AdfDocShape = "doc" | "unknown-version" | "not-a-doc";

export interface AdfConversionOutcome {
  readonly text: string;
  readonly docShape: AdfDocShape;
  readonly truncated: boolean;
  readonly truncationReasons: readonly AdfTruncationReason[];
  readonly unknownNodeTypes: readonly string[];
}

interface ConversionState {
  nodesVisited: number;
  outputChars: number;
  readonly truncationReasons: Set<AdfTruncationReason>;
  readonly unknownNodeTypes: Set<string>;
}

type AdfNode = Record<string, unknown>;
type NodeRenderer = (node: AdfNode, state: ConversionState, depth: number) => string;

// ─── Hostile-input narrowing ────────────────────────────────────────────────────
function asRecord(value: unknown): AdfNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AdfNode)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function attrsOf(node: AdfNode): AdfNode {
  return asRecord(node.attrs) ?? {};
}

// ─── Output budget (charged at every leaf emission; final hard slice in the entry point) ──────
function emit(state: ConversionState, text: string): string {
  if (text.length === 0) return text;
  const remaining = ADF_TO_TEXT_MAX_OUTPUT_CHARS - state.outputChars;
  if (remaining <= 0) {
    state.truncationReasons.add("output-budget-exceeded");
    return "";
  }
  if (text.length <= remaining) {
    state.outputChars += text.length;
    return text;
  }
  state.outputChars = ADF_TO_TEXT_MAX_OUTPUT_CHARS;
  state.truncationReasons.add("output-budget-exceeded");
  return text.slice(0, remaining);
}

// Charges the prefix overhead a container adds on top of already-charged child text, so line
// prefixing (quotes, list indentation) can never amplify output past the budget.
function chargePrefixed(state: ConversionState, prefixed: string, rawLength: number): string {
  const overhead = prefixed.length - rawLength;
  if (overhead <= 0) return prefixed;
  const remaining = ADF_TO_TEXT_MAX_OUTPUT_CHARS - state.outputChars;
  if (overhead <= remaining) {
    state.outputChars += overhead;
    return prefixed;
  }
  state.outputChars = ADF_TO_TEXT_MAX_OUTPUT_CHARS;
  state.truncationReasons.add("output-budget-exceeded");
  return prefixed.slice(0, rawLength + Math.max(0, remaining));
}

function budgetExhausted(state: ConversionState): boolean {
  return state.outputChars >= ADF_TO_TEXT_MAX_OUTPUT_CHARS;
}

// ─── Traversal core ────────────────────────────────────────────────────────────
function renderNode(value: unknown, state: ConversionState, depth: number): string {
  const node = asRecord(value);
  if (node === undefined) return "";
  state.nodesVisited += 1;
  if (state.nodesVisited > ADF_TO_TEXT_MAX_NODES) {
    state.truncationReasons.add("node-budget-exceeded");
    return "";
  }
  if (depth > ADF_TO_TEXT_MAX_DEPTH) {
    state.truncationReasons.add("depth-exceeded");
    return "";
  }
  if (budgetExhausted(state)) return "";
  const type = asString(node.type) ?? "";
  const renderer = NODE_RENDERERS[type];
  if (renderer !== undefined) return renderer(node, state, depth);
  return renderUnknown(node, state, depth, type);
}

function renderChildren(
  node: AdfNode,
  state: ConversionState,
  childDepth: number,
  joiner: string,
): string {
  const parts: string[] = [];
  for (const child of asArray(node.content)) {
    const text = renderNode(child, state, childDepth);
    if (text.length > 0) parts.push(text);
  }
  return parts.join(joiner);
}

// Unknown node types degrade to their concatenated child content — readable fallback text, never
// a throw. The type name (bounded) is reported for diagnostics; node content never is.
function renderUnknown(node: AdfNode, state: ConversionState, depth: number, type: string): string {
  if (state.unknownNodeTypes.size < MAX_UNKNOWN_TYPE_NAMES) {
    const name = type.length === 0 ? "invalid-type" : type.slice(0, MAX_UNKNOWN_TYPE_NAME_CHARS);
    state.unknownNodeTypes.add(name);
  }
  return renderChildren(node, state, depth + 1, "");
}

// ─── Inline nodes ──────────────────────────────────────────────────────────────
function linkHrefOf(node: AdfNode): string | undefined {
  for (const mark of asArray(node.marks)) {
    const record = asRecord(mark);
    if (record === undefined || asString(record.type) !== "link") continue;
    const href = asString(attrsOf(record).href);
    if (href !== undefined && href.length > 0 && href.length <= MAX_LINK_HREF_CHARS) return href;
  }
  return undefined;
}

// Marks render as plain text (no `**`/`_` injection); a link mark appends the target as
// `text (href)` so the URL survives conversion.
function renderText(node: AdfNode, state: ConversionState): string {
  const text = asString(node.text) ?? "";
  const href = linkHrefOf(node);
  if (href === undefined || href === text) return emit(state, text);
  if (text.length === 0) return emit(state, href);
  return emit(state, `${text} (${href})`);
}

function renderMention(node: AdfNode, state: ConversionState): string {
  const attrs = attrsOf(node);
  const text = asString(attrs.text);
  if (text !== undefined && text.length > 0) return emit(state, text);
  const id = asString(attrs.id);
  return emit(state, id !== undefined && id.length > 0 ? `@${id}` : "[mention]");
}

function renderEmoji(node: AdfNode, state: ConversionState): string {
  const attrs = attrsOf(node);
  const value = asString(attrs.text) ?? asString(attrs.shortName) ?? "[emoji]";
  return emit(state, value);
}

function renderStatus(node: AdfNode, state: ConversionState): string {
  return emit(state, asString(attrsOf(node).text) ?? "");
}

// A `date` node's `timestamp` attribute is epoch-milliseconds carried as a number or numeric
// string; anything else yields `Number.NaN` and renders empty.
function timestampToMs(raw: unknown): number {
  if (typeof raw === "number") return raw;
  const text = asString(raw);
  if (text !== undefined && text.length > 0) return Number(text);
  return Number.NaN;
}

// `date` nodes carry an epoch-milliseconds timestamp (as a string); rendered as the ISO calendar
// date in UTC — deterministic and timezone-independent.
function renderDate(node: AdfNode, state: ConversionState): string {
  const ms = timestampToMs(attrsOf(node).timestamp);
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return emit(state, new Date(ms).toISOString().slice(0, 10));
}

function renderCard(node: AdfNode, state: ConversionState): string {
  const url = asString(attrsOf(node).url);
  const bounded = url !== undefined && url.length > 0 && url.length <= MAX_LINK_HREF_CHARS;
  return emit(state, bounded ? url : "[card]");
}

function renderMedia(node: AdfNode, state: ConversionState): string {
  const alt = asString(attrsOf(node).alt);
  return emit(state, alt !== undefined && alt.length > 0 ? `[media: ${alt}]` : "[media]");
}

// ─── Block nodes ───────────────────────────────────────────────────────────────
function renderParagraph(node: AdfNode, state: ConversionState, depth: number): string {
  return renderChildren(node, state, depth + 1, "");
}

function renderHeading(node: AdfNode, state: ConversionState, depth: number): string {
  const raw = attrsOf(node).level;
  const level =
    typeof raw === "number" && Number.isInteger(raw) ? Math.min(6, Math.max(1, raw)) : 1;
  const text = renderChildren(node, state, depth + 1, "");
  const prefix = `${"#".repeat(level)} `;
  return chargePrefixed(state, `${prefix}${text}`, text.length);
}

function renderCodeBlock(node: AdfNode, state: ConversionState, depth: number): string {
  const language = asString(attrsOf(node).language) ?? "";
  const body = renderChildren(node, state, depth + 1, "");
  const fenced = `\`\`\`${language}\n${body}\n\`\`\``;
  return chargePrefixed(state, fenced, body.length);
}

function prefixAllLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderBlockquote(node: AdfNode, state: ConversionState, depth: number): string {
  const body = renderChildren(node, state, depth + 1, "\n\n");
  return chargePrefixed(state, prefixAllLines(body, "> "), body.length);
}

function renderRule(_node: AdfNode, state: ConversionState): string {
  return emit(state, "---");
}

function renderPanel(node: AdfNode, state: ConversionState, depth: number): string {
  return renderChildren(node, state, depth + 1, "\n\n");
}

function renderExpand(node: AdfNode, state: ConversionState, depth: number): string {
  const title = asString(attrsOf(node).title) ?? "";
  const body = renderChildren(node, state, depth + 1, "\n\n");
  if (title.length === 0) return body;
  const emitted = emit(state, title);
  return body.length === 0 ? emitted : `${emitted}\n${body}`;
}

function renderMediaContainer(node: AdfNode, state: ConversionState, depth: number): string {
  const rendered = renderChildren(node, state, depth + 1, "\n");
  return rendered.length > 0 ? rendered : emit(state, "[media]");
}

// ─── Lists ─────────────────────────────────────────────────────────────────────
// One list item: the marker prefixes the first line and continuation lines (including nested
// lists rendered inside the item) indent by the marker's width, so nesting reads as indentation.
function renderListItemWithMarker(
  item: unknown,
  state: ConversionState,
  depth: number,
  marker: string,
): string {
  const node = asRecord(item);
  const body = node === undefined ? "" : renderNode(node, state, depth);
  if (body.length === 0) return "";
  // Continuation lines indent by the marker's width; the marker itself takes the first line.
  const indented = prefixAllLines(body, " ".repeat(marker.length));
  const withMarker = `${marker}${indented.slice(marker.length)}`;
  return chargePrefixed(state, withMarker, body.length);
}

function renderBulletList(node: AdfNode, state: ConversionState, depth: number): string {
  const items = asArray(node.content).map((item) =>
    renderListItemWithMarker(item, state, depth + 1, "- "),
  );
  return items.filter((item) => item.length > 0).join("\n");
}

function renderOrderedList(node: AdfNode, state: ConversionState, depth: number): string {
  const rawStart = attrsOf(node).order;
  const start =
    typeof rawStart === "number" && Number.isInteger(rawStart) && rawStart >= 0 ? rawStart : 1;
  const items = asArray(node.content).map((item, index) =>
    renderListItemWithMarker(item, state, depth + 1, `${String(start + index)}. `),
  );
  return items.filter((item) => item.length > 0).join("\n");
}

function renderListItem(node: AdfNode, state: ConversionState, depth: number): string {
  return renderChildren(node, state, depth + 1, "\n");
}

function renderTaskList(node: AdfNode, state: ConversionState, depth: number): string {
  const items: string[] = [];
  for (const child of asArray(node.content)) {
    const record = asRecord(child);
    const isDone = record !== undefined && asString(attrsOf(record).state) === "DONE";
    const marker = isDone ? "[x] " : "[ ] ";
    const rendered = renderListItemWithMarker(child, state, depth + 1, marker);
    if (rendered.length > 0) items.push(rendered);
  }
  return items.join("\n");
}

// Task and decision items carry INLINE content: children concatenate without separators.
function renderTaskItem(node: AdfNode, state: ConversionState, depth: number): string {
  return renderChildren(node, state, depth + 1, "");
}

function renderDecisionList(node: AdfNode, state: ConversionState, depth: number): string {
  const items = asArray(node.content).map((item) =>
    renderListItemWithMarker(item, state, depth + 1, "Decision: "),
  );
  return items.filter((item) => item.length > 0).join("\n");
}

// ─── Tables (linearized: one row per line, cells separated by ` | `) ───────────
function renderTableCell(node: AdfNode, state: ConversionState, depth: number): string {
  return renderChildren(node, state, depth + 1, "\n").replace(/\n+/gu, " ");
}

function renderTableRow(node: AdfNode, state: ConversionState, depth: number): string {
  const cells = asArray(node.content).map((cell) => renderNode(cell, state, depth + 1));
  return cells.join(" | ");
}

function renderTable(node: AdfNode, state: ConversionState, depth: number): string {
  const rows = asArray(node.content)
    .map((row) => renderNode(row, state, depth + 1))
    .filter((row) => row.length > 0);
  return rows.join("\n");
}

function renderDoc(node: AdfNode, state: ConversionState, depth: number): string {
  return renderChildren(node, state, depth + 1, "\n\n");
}

const NODE_RENDERERS: Readonly<Record<string, NodeRenderer>> = {
  doc: renderDoc,
  paragraph: renderParagraph,
  heading: renderHeading,
  text: (node, state): string => renderText(node, state),
  hardBreak: (_node, state): string => emit(state, "\n"),
  mention: (node, state): string => renderMention(node, state),
  emoji: (node, state): string => renderEmoji(node, state),
  status: (node, state): string => renderStatus(node, state),
  date: (node, state): string => renderDate(node, state),
  inlineCard: (node, state): string => renderCard(node, state),
  blockCard: (node, state): string => renderCard(node, state),
  embedCard: (node, state): string => renderCard(node, state),
  media: (node, state): string => renderMedia(node, state),
  mediaGroup: renderMediaContainer,
  mediaSingle: renderMediaContainer,
  mediaInline: (node, state): string => renderMedia(node, state),
  codeBlock: renderCodeBlock,
  blockquote: renderBlockquote,
  rule: renderRule,
  panel: renderPanel,
  expand: renderExpand,
  nestedExpand: renderExpand,
  bulletList: renderBulletList,
  orderedList: renderOrderedList,
  listItem: renderListItem,
  taskList: renderTaskList,
  taskItem: renderTaskItem,
  decisionList: renderDecisionList,
  decisionItem: renderTaskItem,
  table: renderTable,
  tableRow: renderTableRow,
  tableCell: renderTableCell,
  tableHeader: renderTableCell,
};

// ─── Entry point ───────────────────────────────────────────────────────────────
function classifyDocShape(value: unknown): AdfDocShape {
  const node = asRecord(value);
  if (node === undefined || asString(node.type) !== "doc") return "not-a-doc";
  return node.version === ADF_SUPPORTED_DOC_VERSION ? "doc" : "unknown-version";
}

// Convert one hostile ADF value to bounded plain text. Total: never throws; unknown versions and
// non-doc nodes degrade to best-effort content; caps surface as closed truncation reasons.
export function convertAdfToText(value: unknown): AdfConversionOutcome {
  const state: ConversionState = {
    nodesVisited: 0,
    outputChars: 0,
    truncationReasons: new Set<AdfTruncationReason>(),
    unknownNodeTypes: new Set<string>(),
  };
  const docShape = classifyDocShape(value);
  let text = renderNode(value, state, 0);
  if (text.length > ADF_TO_TEXT_MAX_OUTPUT_CHARS) {
    state.truncationReasons.add("output-budget-exceeded");
    text = text.slice(0, ADF_TO_TEXT_MAX_OUTPUT_CHARS);
  }
  return {
    text,
    docShape,
    truncated: state.truncationReasons.size > 0,
    truncationReasons: [...state.truncationReasons].sort(compareByCodeUnit),
    unknownNodeTypes: [...state.unknownNodeTypes].sort(compareByCodeUnit),
  };
}
