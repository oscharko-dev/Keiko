// Quality Intelligence — ADF parser (Epic #270, Issue #278; parser audit #4235).
//
// Deterministic parser for the Atlassian Document Format (ADF) JSON tree. Used to turn
// structured Jira/Confluence-style content into a normalised internal `IngestedDocument`
// shape the QI ingestion pipeline can map onto evidence atoms.
//
// Pure: no IO, no network, no `node:fs`, no `XMLHttpRequest`, no clock reads. Throws a
// typed `AdfParserError` for structurally malformed input (not an object, wrong root, invalid
// heading level, depth/node/size bombs, cycles). A node type the parser does not know is NOT an
// error: Atlassian adds node types over time, so it degrades to the text of its children and is
// named in `stats.unknownNodeTypes` (type names only, never content). Bounded recursion + node
// count keep depth-bomb inputs from blowing the stack or running for unbounded time.
//
// The structural node set mirrors keiko-connectors `adf-to-text.ts` (the Jira read path), so a
// requirement reads the same whether it arrives from a connector or as an `adf` tree. Text is
// normalised with the audit-ledger rules in untrustedContentNormalisation.ts.

import { normaliseUntrustedContent } from "./untrustedContentNormalisation.js";

const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;
// KEIKO-0891: overall serialised-JSON ceiling for the whole ADF tree, independent of the
// node/depth/text-run bounds above. Those bounds only examine fields the parser actually visits
// (`type`, `content`, `attrs`, `marks`, `text`) — an oversized value sitting in an unvisited/unknown
// JSON property (e.g. a bogus top-level key the whitelist never reads) would otherwise pass through
// unexamined. Set at 2 MiB to match keiko-server's existing whole-request-body ceiling
// (`runRoutes.ts` MAX_BODY_BYTES), so this can never reject a payload that would have been accepted
// anyway — the `adf` field is always a strict subset of that request body.
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_UNKNOWN_TYPE_NAMES = 20;
const MAX_UNKNOWN_TYPE_NAME_CHARS = 60;

export type AdfParserErrorCode =
  | "ROOT_NOT_OBJECT"
  | "ROOT_TYPE_MISMATCH"
  | "DOCUMENT_TOO_LARGE"
  | "UNKNOWN_NODE_TYPE"
  | "NODE_NOT_OBJECT"
  | "MAX_DEPTH_EXCEEDED"
  | "MAX_NODES_EXCEEDED"
  | "CIRCULAR_REFERENCE"
  | "INVALID_HEADING_LEVEL";

export class AdfParserError extends Error {
  public readonly code: AdfParserErrorCode;
  public readonly path: string;
  constructor(code: AdfParserErrorCode, path: string, message: string) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "AdfParserError";
    this.code = code;
    this.path = path;
  }
}

export interface AdfParserOptions {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxTextBytes?: number;
  /** Maximum serialised-JSON UTF-8 byte length of the whole input tree. See KEIKO-0891. */
  readonly maxDocumentBytes?: number;
}

export interface IngestedTextRun {
  readonly text: string;
  readonly clamped: boolean;
  readonly markdownInjectionEscapes: number;
}

export type IngestedBlock =
  | { readonly kind: "paragraph"; readonly runs: readonly IngestedTextRun[] }
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly runs: readonly IngestedTextRun[];
    }
  | { readonly kind: "bulletList"; readonly items: readonly IngestedBlock[] }
  | {
      readonly kind: "orderedList";
      /** First item number (`attrs.order`), 1 when absent. */
      readonly start: number;
      readonly items: readonly IngestedBlock[];
    }
  | { readonly kind: "listItem"; readonly content: readonly IngestedBlock[] }
  | { readonly kind: "taskList"; readonly items: readonly IngestedBlock[] }
  | {
      readonly kind: "taskItem";
      readonly done: boolean;
      readonly content: readonly IngestedBlock[];
    }
  | { readonly kind: "decisionList"; readonly items: readonly IngestedBlock[] }
  | { readonly kind: "decisionItem"; readonly content: readonly IngestedBlock[] }
  | { readonly kind: "codeBlock"; readonly language: string | null; readonly text: string }
  | { readonly kind: "panel"; readonly content: readonly IngestedBlock[] }
  | { readonly kind: "blockquote"; readonly content: readonly IngestedBlock[] }
  | {
      readonly kind: "expand";
      readonly title: string;
      readonly content: readonly IngestedBlock[];
    }
  | { readonly kind: "rule" }
  | { readonly kind: "media"; readonly label: string }
  | { readonly kind: "table"; readonly rows: readonly IngestedBlock[] }
  | { readonly kind: "tableRow"; readonly cells: readonly IngestedBlock[] }
  | {
      readonly kind: "tableCell";
      readonly header: boolean;
      readonly content: readonly IngestedBlock[];
    };

export interface IngestedDocument {
  readonly version: 1;
  readonly blocks: readonly IngestedBlock[];
  readonly stats: {
    readonly nodes: number;
    readonly maxDepthReached: number;
    /** Text runs and code blocks cut at `maxTextBytes`; a non-zero count is lost content. */
    readonly truncatedBlocks: number;
    /** Distinct node types the parser degraded to their child text, sorted, bounded. */
    readonly unknownNodeTypes: readonly string[];
  };
}

type Node = Record<string, unknown>;

const INLINE_TYPES = new Set([
  "text",
  "status",
  "hardBreak",
  "mention",
  "emoji",
  "date",
  "inlineCard",
  "mediaInline",
]);

const KNOWN_BLOCK_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "decisionList",
  "decisionItem",
  "codeBlock",
  "panel",
  "blockquote",
  "expand",
  "nestedExpand",
  "rule",
  "media",
  "mediaSingle",
  "mediaGroup",
  "blockCard",
  "embedCard",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
]);

interface ParserState {
  nodeCount: number;
  maxDepthReached: number;
  clampedCount: number;
  readonly unknownTypes: Set<string>;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxTextBytes: number;
  readonly seen: WeakSet<object>;
}

const isPlainObject = (value: unknown): value is Node => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const incrementNodes = (state: ParserState, path: string): void => {
  state.nodeCount += 1;
  if (state.nodeCount > state.maxNodes) {
    throw new AdfParserError(
      "MAX_NODES_EXCEEDED",
      path,
      `Exceeded maxNodes (${String(state.maxNodes)})`,
    );
  }
};

const checkDepth = (state: ParserState, depth: number, path: string): void => {
  if (depth > state.maxDepth) {
    throw new AdfParserError(
      "MAX_DEPTH_EXCEEDED",
      path,
      `Exceeded maxDepth (${String(state.maxDepth)})`,
    );
  }
  if (depth > state.maxDepthReached) state.maxDepthReached = depth;
};

const markSeen = (state: ParserState, node: Node, path: string): void => {
  if (state.seen.has(node)) {
    throw new AdfParserError("CIRCULAR_REFERENCE", path, "Node visited twice");
  }
  state.seen.add(node);
};

// KEIKO-0891: measures the whole root object, not just the fields the walk below visits, so a
// huge value hiding in an unknown/unvisited JSON property is still caught. Returns `undefined`
// (rather than throwing, or treating unmeasurable as oversized) when the value cannot be
// serialised — a genuine cycle, for example — so that case is left to the existing per-node
// `markSeen` walk below, which reports the more specific CIRCULAR_REFERENCE code instead of being
// masked by a generic size failure here.
const measureDocumentBytes = (raw: Node): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(raw)).length;
  } catch {
    return undefined;
  }
};

const assertObjectNode = (raw: unknown, path: string): Node => {
  if (!isPlainObject(raw)) {
    throw new AdfParserError("NODE_NOT_OBJECT", path, "Expected an object node");
  }
  return raw;
};

const getNodeType = (node: Node, path: string): string => {
  const type = node.type;
  if (typeof type !== "string") {
    throw new AdfParserError("NODE_NOT_OBJECT", path, "Node `type` must be a string");
  }
  return type;
};

const collectArrayContent = (node: Node): readonly unknown[] => {
  const content = node.content;
  return Array.isArray(content) ? content : [];
};

const attrsOf = (node: Node): Node => (isPlainObject(node.attrs) ? node.attrs : {});

const stringAttr = (node: Node, key: string): string | undefined => {
  const value = attrsOf(node)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const recordUnknownType = (state: ParserState, type: string): void => {
  if (KNOWN_BLOCK_TYPES.has(type) || INLINE_TYPES.has(type)) return;
  if (state.unknownTypes.size >= MAX_UNKNOWN_TYPE_NAMES) return;
  state.unknownTypes.add(
    type.length === 0 ? "invalid-type" : type.slice(0, MAX_UNKNOWN_TYPE_NAME_CHARS),
  );
};

// ─── Inline content ────────────────────────────────────────────────────────────

const makeRun = (rawText: string, state: ParserState): IngestedTextRun => {
  const normalised = normaliseUntrustedContent(rawText, { maxBytes: state.maxTextBytes });
  if (normalised.clamped) state.clampedCount += 1;
  return {
    text: normalised.value,
    clamped: normalised.clamped,
    markdownInjectionEscapes: normalised.markdownInjectionEscapes,
  };
};

// A link mark keeps the visible text AND its target (`text (href)`), in place: dropping either
// loses a reference the requirement may depend on. A link without a usable href is plain text.
const linkHref = (node: Node): string | undefined => {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  for (const mark of marks) {
    if (!isPlainObject(mark) || mark.type !== "link") continue;
    const href = stringAttr(mark, "href");
    if (href !== undefined) return href;
  }
  return undefined;
};

const textNodeText = (node: Node, state: ParserState): string => {
  const rawText = typeof node.text === "string" ? node.text : "";
  const href = linkHref(node);
  if (href === undefined || href === rawText) return rawText;
  const hrefLabel = normaliseUntrustedContent(href, { maxBytes: state.maxTextBytes }).value;
  return rawText.length === 0 ? hrefLabel : `${rawText} (${hrefLabel})`;
};

const dateText = (node: Node): string => {
  const raw = attrsOf(node).timestamp;
  const ms = typeof raw === "number" ? raw : Number(typeof raw === "string" ? raw : Number.NaN);
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return civilDate(Math.floor(ms / 86_400_000));
};

// Calendar date (UTC) of a day count since 1970-01-01, by integer arithmetic (the proleptic
// Gregorian "civil from days" algorithm): deterministic, no clock or timezone involved.
const civilDate = (daysSinceEpoch: number): string => {
  const z = daysSinceEpoch + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shifted = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1;
  const month = shifted < 10 ? shifted + 3 : shifted - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
};

const mentionText = (node: Node): string => {
  const text = stringAttr(node, "text");
  if (text !== undefined) return text;
  const id = stringAttr(node, "id");
  return id === undefined ? "[mention]" : `@${id}`;
};

const mediaLabel = (node: Node): string => {
  const alt = stringAttr(node, "alt");
  return alt === undefined ? "[media]" : `[media: ${alt}]`;
};

const emojiText = (node: Node): string =>
  stringAttr(node, "text") ?? stringAttr(node, "shortName") ?? "[emoji]";

const INLINE_TEXT: Readonly<Record<string, (node: Node, state: ParserState) => string>> = {
  text: textNodeText,
  status: (node) => stringAttr(node, "text") ?? "",
  hardBreak: () => "\n",
  mention: mentionText,
  emoji: emojiText,
  date: dateText,
  inlineCard: (node) => stringAttr(node, "url") ?? "[card]",
  mediaInline: mediaLabel,
};

const inlineNodeText = (node: Node, type: string, state: ParserState): string =>
  INLINE_TEXT[type]?.(node, state) ?? "";

// A node of an unknown type in inline position contributes the text of its own children.
const parseUnknownInline = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): readonly IngestedTextRun[] => {
  checkDepth(state, depth, path);
  return parseInlineContent(collectArrayContent(node), `${path}.content`, depth + 1, state);
};

const parseInlineChild = (
  childNode: Node,
  path: string,
  depth: number,
  state: ParserState,
): readonly IngestedTextRun[] => {
  const type = getNodeType(childNode, path);
  if (INLINE_TYPES.has(type)) {
    incrementNodes(state, path);
    return [makeRun(inlineNodeText(childNode, type, state), state)];
  }
  if (KNOWN_BLOCK_TYPES.has(type)) {
    throw new AdfParserError("UNKNOWN_NODE_TYPE", path, `Expected inline text, got "${type}"`);
  }
  incrementNodes(state, path);
  recordUnknownType(state, type);
  return parseUnknownInline(childNode, path, depth, state);
};

function parseInlineContent(
  rawChildren: readonly unknown[],
  pathPrefix: string,
  depth: number,
  state: ParserState,
  offset = 0,
): readonly IngestedTextRun[] {
  checkDepth(state, depth, pathPrefix);
  const runs: IngestedTextRun[] = [];
  rawChildren.forEach((child, index) => {
    const path = `${pathPrefix}[${String(index + offset)}]`;
    const childNode = assertObjectNode(child, path);
    markSeen(state, childNode, path);
    runs.push(...parseInlineChild(childNode, path, depth, state));
  });
  return runs;
}

// ─── Block content ─────────────────────────────────────────────────────────────

const isInlineChild = (child: unknown): boolean =>
  isPlainObject(child) && typeof child.type === "string" && INLINE_TYPES.has(child.type);

// Children of a block container. Inline nodes sitting directly in a container (task items,
// decision items, and malformed documents) are grouped into one paragraph instead of being lost
// or rejected.
function parseContainerContent(
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): readonly IngestedBlock[] {
  const children = collectArrayContent(node);
  const blocks: IngestedBlock[] = [];
  let index = 0;
  while (index < children.length) {
    if (isInlineChild(children[index])) {
      let end = index;
      while (end < children.length && isInlineChild(children[end])) end += 1;
      const runs = parseInlineContent(
        children.slice(index, end),
        `${path}.content`,
        depth + 1,
        state,
        index,
      );
      blocks.push({ kind: "paragraph", runs });
      index = end;
    } else {
      blocks.push(
        parseBlock(children[index], `${path}.content[${String(index)}]`, depth + 1, state),
      );
      index += 1;
    }
  }
  return blocks;
}

const parseHeading = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => {
  const rawLevel = attrsOf(node).level;
  if (typeof rawLevel !== "number" || !Number.isInteger(rawLevel) || rawLevel < 1 || rawLevel > 6) {
    throw new AdfParserError("INVALID_HEADING_LEVEL", path, "Heading level must be integer 1–6");
  }
  const runs = parseInlineContent(collectArrayContent(node), `${path}.content`, depth + 1, state);
  return { kind: "heading", level: rawLevel as 1 | 2 | 3 | 4 | 5 | 6, runs };
};

const parseCodeBlock = (node: Node, path: string, state: ParserState): IngestedBlock => {
  const rawLanguage = attrsOf(node).language;
  const language =
    typeof rawLanguage === "string" && rawLanguage.length > 0
      ? normaliseUntrustedContent(rawLanguage, { maxBytes: 256 }).value
      : null;
  let combined = "";
  collectArrayContent(node).forEach((child, index) => {
    const childPath = `${path}.content[${String(index)}]`;
    const childNode = assertObjectNode(child, childPath);
    markSeen(state, childNode, childPath);
    incrementNodes(state, childPath);
    if (childNode.type === "text" && typeof childNode.text === "string") combined += childNode.text;
    if (childNode.type === "hardBreak") combined += "\n";
  });
  const normalised = normaliseUntrustedContent(combined, { maxBytes: state.maxTextBytes });
  if (normalised.clamped) state.clampedCount += 1;
  return { kind: "codeBlock", language, text: normalised.value };
};

// A list child that is not the expected item type is kept as the content of a synthetic item
// rather than rejected: the text it carries is still a requirement.
const parseItemChildren = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
  itemType: string,
  toItem: (content: readonly IngestedBlock[], child: Node) => IngestedBlock,
): readonly IngestedBlock[] =>
  collectArrayContent(node).map((child, index) => {
    const cp = `${path}.content[${String(index)}]`;
    const childNode = assertObjectNode(child, cp);
    if (childNode.type !== itemType) {
      return toItem([parseBlock(childNode, cp, depth + 1, state)], childNode);
    }
    markSeen(state, childNode, cp);
    incrementNodes(state, cp);
    return toItem(parseContainerContent(childNode, cp, depth + 1, state), childNode);
  });

const parseList = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
  kind: "bulletList" | "orderedList",
): IngestedBlock => {
  const items = parseItemChildren(node, path, depth, state, "listItem", (content) => ({
    kind: "listItem",
    content,
  }));
  if (kind === "bulletList") return { kind, items };
  const order = attrsOf(node).order;
  const start = typeof order === "number" && Number.isInteger(order) && order >= 0 ? order : 1;
  return { kind, start, items };
};

const parseTaskList = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => ({
  kind: "taskList",
  items: parseItemChildren(node, path, depth, state, "taskItem", (content, child) => ({
    kind: "taskItem",
    done: attrsOf(child).state === "DONE",
    content,
  })),
});

const parseDecisionList = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => ({
  kind: "decisionList",
  items: parseItemChildren(node, path, depth, state, "decisionItem", (content) => ({
    kind: "decisionItem",
    content,
  })),
});

const parseTableRow = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => {
  const cells = collectArrayContent(node).map((child, index): IngestedBlock => {
    const cp = `${path}.content[${String(index)}]`;
    const childNode = assertObjectNode(child, cp);
    if (childNode.type !== "tableCell" && childNode.type !== "tableHeader") {
      return {
        kind: "tableCell",
        header: false,
        content: [parseBlock(childNode, cp, depth + 1, state)],
      };
    }
    markSeen(state, childNode, cp);
    incrementNodes(state, cp);
    return {
      kind: "tableCell",
      header: childNode.type === "tableHeader",
      content: parseContainerContent(childNode, cp, depth + 1, state),
    };
  });
  return { kind: "tableRow", cells };
};

const parseTable = (node: Node, path: string, depth: number, state: ParserState): IngestedBlock => {
  const rows = collectArrayContent(node).map((child, index): IngestedBlock => {
    const cp = `${path}.content[${String(index)}]`;
    const childNode = assertObjectNode(child, cp);
    if (childNode.type !== "tableRow") {
      const cell: IngestedBlock = {
        kind: "tableCell",
        header: false,
        content: [parseBlock(childNode, cp, depth + 1, state)],
      };
      return { kind: "tableRow", cells: [cell] };
    }
    markSeen(state, childNode, cp);
    incrementNodes(state, cp);
    return parseTableRow(childNode, cp, depth + 1, state);
  });
  return { kind: "table", rows };
};

const parseMediaContainer = (
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => {
  const content = parseContainerContent(node, path, depth, state);
  return content.length > 0 ? { kind: "panel", content } : { kind: "media", label: "[media]" };
};

// Card nodes carry a target, not text.
const parseCard = (node: Node): IngestedBlock => ({
  kind: "paragraph",
  runs: [
    { text: stringAttr(node, "url") ?? "[card]", clamped: false, markdownInjectionEscapes: 0 },
  ],
});

function parseTypedBlock(
  type: string,
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock | undefined {
  switch (type) {
    case "paragraph":
      return {
        kind: "paragraph",
        runs: parseInlineContent(collectArrayContent(node), `${path}.content`, depth + 1, state),
      };
    case "heading":
      return parseHeading(node, path, depth, state);
    case "bulletList":
    case "orderedList":
      return parseList(node, path, depth, state, type);
    case "taskList":
      return parseTaskList(node, path, depth, state);
    case "decisionList":
      return parseDecisionList(node, path, depth, state);
    case "codeBlock":
      return parseCodeBlock(node, path, state);
    case "table":
      return parseTable(node, path, depth, state);
    case "tableRow":
      return parseTableRow(node, path, depth, state);
    default:
      return undefined;
  }
}

// Containers that hold block children. `expand` keeps its title, `blockquote` its quoting.
// eslint-disable-next-line complexity -- flat type dispatch, one case per ADF container type
function parseContainerBlock(
  type: string,
  node: Node,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock | undefined {
  switch (type) {
    case "blockquote":
      return { kind: "blockquote", content: parseContainerContent(node, path, depth, state) };
    case "expand":
    case "nestedExpand":
      return {
        kind: "expand",
        title: stringAttr(node, "title") ?? "",
        content: parseContainerContent(node, path, depth, state),
      };
    case "mediaSingle":
    case "mediaGroup":
      return parseMediaContainer(node, path, depth, state);
    case "media":
      return { kind: "media", label: mediaLabel(node) };
    case "blockCard":
    case "embedCard":
      return parseCard(node);
    case "rule":
      return { kind: "rule" };
    case "listItem":
    case "taskItem":
    case "decisionItem":
    case "panel":
      return { kind: "panel", content: parseContainerContent(node, path, depth, state) };
    case "tableCell":
    case "tableHeader":
      return {
        kind: "tableCell",
        header: type === "tableHeader",
        content: parseContainerContent(node, path, depth, state),
      };
    default:
      return undefined;
  }
}

function parseBlock(raw: unknown, path: string, depth: number, state: ParserState): IngestedBlock {
  const node = assertObjectNode(raw, path);
  markSeen(state, node, path);
  incrementNodes(state, path);
  checkDepth(state, depth, path);
  const type = getNodeType(node, path);
  const typed = parseTypedBlock(type, node, path, depth, state);
  if (typed !== undefined) return typed;
  const container = parseContainerBlock(type, node, path, depth, state);
  if (container !== undefined) return container;
  if (INLINE_TYPES.has(type)) {
    return {
      kind: "paragraph",
      runs: [makeRun(inlineNodeText(node, type, state), state)],
    };
  }
  recordUnknownType(state, type);
  return { kind: "panel", content: parseContainerContent(node, path, depth, state) };
}

/**
 * Parse a JSON-decoded ADF tree into an `IngestedDocument`. Throws `AdfParserError` for
 * malformed structure, depth-bombs, an oversized document, or circular references; unknown
 * node types degrade to their child text. Pure.
 */
export const parseAdfDocument = (
  raw: unknown,
  options: AdfParserOptions = {},
): IngestedDocument => {
  if (!isPlainObject(raw)) {
    throw new AdfParserError("ROOT_NOT_OBJECT", "$", "ADF root must be a JSON object");
  }
  if (raw.type !== "doc") {
    throw new AdfParserError("ROOT_TYPE_MISMATCH", "$", 'ADF root type must be "doc"');
  }
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const documentBytes = measureDocumentBytes(raw);
  if (documentBytes !== undefined && documentBytes > maxDocumentBytes) {
    throw new AdfParserError(
      "DOCUMENT_TOO_LARGE",
      "$",
      `Exceeded maxDocumentBytes (${String(maxDocumentBytes)})`,
    );
  }
  const state: ParserState = {
    nodeCount: 0,
    maxDepthReached: 0,
    clampedCount: 0,
    unknownTypes: new Set<string>(),
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxTextBytes: options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
    seen: new WeakSet(),
  };
  markSeen(state, raw, "$");
  incrementNodes(state, "$");
  const blocks = parseContainerContent(raw, "$", 0, state);
  return {
    version: 1,
    blocks,
    stats: {
      nodes: state.nodeCount,
      maxDepthReached: state.maxDepthReached,
      truncatedBlocks: state.clampedCount,
      unknownNodeTypes: [...state.unknownTypes].sort(),
    },
  };
};

// ─── Rendering ─────────────────────────────────────────────────────────────────

const joinRuns = (runs: readonly IngestedTextRun[]): string =>
  runs
    .map((run) => run.text)
    .join("")
    .trim();

const flatten = (text: string): string => text.replace(/\s*\n\s*/gu, " ").trim();

const renderContent = (content: readonly IngestedBlock[]): readonly string[] =>
  content.flatMap((inner) => renderBlock(inner));

const splitLines = (lines: readonly string[]): readonly string[] =>
  lines.flatMap((line) => line.split("\n"));

// The marker takes the first line; continuation lines (further paragraphs, nested lists) indent by
// the marker's width so nesting and item grouping survive in plain text.
const renderItem = (content: readonly IngestedBlock[], marker: string): readonly string[] => {
  const lines = splitLines(renderContent(content));
  if (lines.length === 0) return [];
  const indent = " ".repeat(marker.length);
  return lines.map((line, index) => (index === 0 ? `${marker}${line}` : `${indent}${line}`));
};

const itemContent = (item: IngestedBlock): readonly IngestedBlock[] =>
  "content" in item ? item.content : [item];

const renderCell = (block: IngestedBlock): string =>
  flatten(
    block.kind === "tableCell"
      ? renderContent(block.content).join(" ")
      : renderBlock(block).join(" "),
  );

const cellsOf = (row: IngestedBlock): readonly IngestedBlock[] =>
  row.kind === "tableRow" ? row.cells : [row];

const renderRow = (row: IngestedBlock): string =>
  `| ${cellsOf(row)
    .map((cell) => renderCell(cell))
    .join(" | ")} |`;

// A header row (every cell a `tableHeader`) is followed by a Markdown separator row, so the
// column names stay a header for the requirement table reader instead of becoming a data row.
const renderTable = (rows: readonly IngestedBlock[]): readonly string[] => {
  const lines: string[] = [];
  rows.forEach((row, index) => {
    lines.push(renderRow(row));
    const cells = cellsOf(row);
    const isHeader = cells.length > 0 && cells.every((c) => c.kind === "tableCell" && c.header);
    if (index === 0 && isHeader) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
  });
  return lines;
};

// eslint-disable-next-line complexity -- flat kind dispatch, one case per block kind
function renderBlock(block: IngestedBlock): readonly string[] {
  switch (block.kind) {
    case "paragraph": {
      const text = joinRuns(block.runs);
      return text.length === 0 ? [] : [text];
    }
    case "heading": {
      const text = flatten(joinRuns(block.runs));
      return text.length === 0 ? [] : [`${"#".repeat(block.level)} ${text}`];
    }
    case "bulletList":
      return block.items.flatMap((item) => renderItem(itemContent(item), "- "));
    case "orderedList":
      return block.items.flatMap((item, index) =>
        renderItem(itemContent(item), `${String(block.start + index)}. `),
      );
    case "taskList":
      return block.items.flatMap((item) =>
        renderItem(itemContent(item), item.kind === "taskItem" && item.done ? "[x] " : "[ ] "),
      );
    case "decisionList":
      return block.items.flatMap((item) => renderItem(itemContent(item), "Decision: "));
    case "codeBlock":
      return block.text.trim().length === 0
        ? []
        : [`\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``];
    case "blockquote":
      return splitLines(renderContent(block.content)).map((line) => `> ${line}`);
    case "expand":
      return [...(block.title.length === 0 ? [] : [block.title]), ...renderContent(block.content)];
    case "rule":
      return ["---"];
    case "media":
      return [block.label];
    case "table":
      return renderTable(block.rows);
    case "tableRow":
      return [renderRow(block)];
    case "tableCell": {
      const text = renderCell(block);
      return text.length === 0 ? [] : [text];
    }
    case "listItem":
    case "taskItem":
    case "decisionItem":
    case "panel":
      return renderContent(block.content);
  }
}

export const renderAdfDocumentText = (document: IngestedDocument): string =>
  document.blocks
    .flatMap((block) => renderBlock(block))
    .join("\n")
    .trim();

export const ADF_PARSER_DEFAULTS = {
  maxNodes: DEFAULT_MAX_NODES,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
  maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
} as const;
