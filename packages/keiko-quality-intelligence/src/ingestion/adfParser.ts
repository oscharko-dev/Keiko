// Quality Intelligence — ADF parser (Epic #270, Issue #278).
//
// Deterministic parser for the Atlassian Document Format (ADF) JSON tree. Used to turn
// structured Jira/Confluence-style content into a normalised internal `IngestedDocument`
// shape the QI ingestion pipeline can map onto evidence atoms.
//
// Pure: no IO, no network, no `node:fs`, no `XMLHttpRequest`, no clock reads. Throws a
// typed `AdfParserError` for malformed or unknown nodes. Bounded recursion + node count
// keep depth-bomb inputs from blowing the stack or running for unbounded time.
//
// Structurally inspired by Test Intelligence reference (TI) ADF handling, but the
// supported node set is a strict whitelist anchored on the Keiko contracts surface and
// the audit-ledger normalisation rules already encoded in
// @oscharko-dev/keiko-contracts/qualityIntelligence/ids.ts.

import { normaliseUntrustedContent } from "./untrustedContentNormalisation.js";

const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;

export type AdfParserErrorCode =
  | "ROOT_NOT_OBJECT"
  | "ROOT_TYPE_MISMATCH"
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
  | { readonly kind: "orderedList"; readonly items: readonly IngestedBlock[] }
  | { readonly kind: "listItem"; readonly content: readonly IngestedBlock[] }
  | { readonly kind: "codeBlock"; readonly language: string | null; readonly text: string }
  | { readonly kind: "linkRef"; readonly displayText: string; readonly hrefLabel: string };

export interface IngestedDocument {
  readonly version: 1;
  readonly blocks: readonly IngestedBlock[];
  readonly stats: {
    readonly nodes: number;
    readonly maxDepthReached: number;
    readonly truncatedBlocks: number;
  };
}

const KNOWN_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "text",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
]);

interface ParserState {
  nodeCount: number;
  maxDepthReached: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxTextBytes: number;
  readonly seen: WeakSet<object>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
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

const markSeen = (state: ParserState, node: Record<string, unknown>, path: string): void => {
  if (state.seen.has(node)) {
    throw new AdfParserError("CIRCULAR_REFERENCE", path, "Node visited twice");
  }
  state.seen.add(node);
};

const assertObjectNode = (raw: unknown, path: string): Record<string, unknown> => {
  if (!isPlainObject(raw)) {
    throw new AdfParserError("NODE_NOT_OBJECT", path, "Expected an object node");
  }
  return raw;
};

const getNodeType = (node: Record<string, unknown>, path: string): string => {
  const type = node.type;
  if (typeof type !== "string") {
    throw new AdfParserError("NODE_NOT_OBJECT", path, "Node `type` must be a string");
  }
  if (!KNOWN_NODE_TYPES.has(type)) {
    throw new AdfParserError("UNKNOWN_NODE_TYPE", path, `Unknown node type "${type}"`);
  }
  return type;
};

const collectArrayContent = (node: Record<string, unknown>): readonly unknown[] => {
  const content = node.content;
  return Array.isArray(content) ? content : [];
};

const collectMarks = (node: Record<string, unknown>): readonly unknown[] => {
  const marks = node.marks;
  return Array.isArray(marks) ? marks : [];
};

interface RunOrLink {
  readonly run: IngestedTextRun | null;
  readonly link: IngestedBlock | null;
}

const buildLinkRef = (
  rawText: string,
  marks: readonly unknown[],
  state: ParserState,
): IngestedBlock | null => {
  for (const mark of marks) {
    if (!isPlainObject(mark)) continue;
    if (mark.type !== "link") continue;
    const attrs = mark.attrs;
    const href = isPlainObject(attrs) && typeof attrs.href === "string" ? attrs.href : "(href)";
    const hrefLabel = normaliseUntrustedContent(href, { maxBytes: state.maxTextBytes }).value;
    const displayText = normaliseUntrustedContent(rawText, { maxBytes: state.maxTextBytes }).value;
    return { kind: "linkRef", displayText, hrefLabel };
  }
  return null;
};

const parseTextNode = (
  node: Record<string, unknown>,
  path: string,
  state: ParserState,
): RunOrLink => {
  incrementNodes(state, path);
  const rawText = typeof node.text === "string" ? node.text : "";
  const marks = collectMarks(node);
  const link = buildLinkRef(rawText, marks, state);
  if (link !== null) {
    return { run: null, link };
  }
  const normalised = normaliseUntrustedContent(rawText, { maxBytes: state.maxTextBytes });
  return {
    run: {
      text: normalised.value,
      clamped: normalised.clamped,
      markdownInjectionEscapes: normalised.markdownInjectionEscapes,
    },
    link: null,
  };
};

const parseInlineContent = (
  rawChildren: readonly unknown[],
  pathPrefix: string,
  depth: number,
  state: ParserState,
): { runs: readonly IngestedTextRun[]; links: readonly IngestedBlock[] } => {
  checkDepth(state, depth, pathPrefix);
  const runs: IngestedTextRun[] = [];
  const links: IngestedBlock[] = [];
  rawChildren.forEach((child, index) => {
    const path = `${pathPrefix}[${String(index)}]`;
    const childNode = assertObjectNode(child, path);
    markSeen(state, childNode, path);
    const type = getNodeType(childNode, path);
    if (type !== "text") {
      throw new AdfParserError("UNKNOWN_NODE_TYPE", path, `Expected inline text, got "${type}"`);
    }
    const parsed = parseTextNode(childNode, path, state);
    if (parsed.run !== null) runs.push(parsed.run);
    if (parsed.link !== null) links.push(parsed.link);
  });
  return { runs, links };
};

const parseHeading = (
  node: Record<string, unknown>,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => {
  const attrs = node.attrs;
  const rawLevel = isPlainObject(attrs) ? attrs.level : undefined;
  if (typeof rawLevel !== "number" || !Number.isInteger(rawLevel) || rawLevel < 1 || rawLevel > 6) {
    throw new AdfParserError("INVALID_HEADING_LEVEL", path, "Heading level must be integer 1–6");
  }
  const inline = parseInlineContent(collectArrayContent(node), `${path}.content`, depth + 1, state);
  return {
    kind: "heading",
    level: rawLevel as 1 | 2 | 3 | 4 | 5 | 6,
    runs: inline.runs,
  };
};

const parseCodeBlock = (
  node: Record<string, unknown>,
  path: string,
  state: ParserState,
): IngestedBlock => {
  const attrs = node.attrs;
  const rawLanguage = isPlainObject(attrs) ? attrs.language : undefined;
  const language =
    typeof rawLanguage === "string" && rawLanguage.length > 0
      ? normaliseUntrustedContent(rawLanguage, { maxBytes: 256 }).value
      : null;
  const inline = collectArrayContent(node);
  let combined = "";
  inline.forEach((child, index) => {
    const childPath = `${path}.content[${String(index)}]`;
    const childNode = assertObjectNode(child, childPath);
    markSeen(state, childNode, childPath);
    incrementNodes(state, childPath);
    if (childNode.type !== "text") {
      throw new AdfParserError(
        "UNKNOWN_NODE_TYPE",
        childPath,
        "codeBlock content must be text nodes",
      );
    }
    const t = childNode.text;
    if (typeof t === "string") combined += t;
  });
  const normalised = normaliseUntrustedContent(combined, { maxBytes: state.maxTextBytes });
  return { kind: "codeBlock", language, text: normalised.value };
};

const parseListItem = (
  node: Record<string, unknown>,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => {
  const childPath = `${path}.content`;
  const children = collectArrayContent(node);
  const inner: IngestedBlock[] = [];
  children.forEach((child, index) => {
    const cp = `${childPath}[${String(index)}]`;
    inner.push(parseBlock(child, cp, depth + 1, state));
  });
  return { kind: "listItem", content: inner };
};

const parseBulletOrOrderedList = (
  node: Record<string, unknown>,
  path: string,
  depth: number,
  state: ParserState,
  kind: "bulletList" | "orderedList",
): IngestedBlock => {
  const children = collectArrayContent(node);
  const items: IngestedBlock[] = [];
  children.forEach((child, index) => {
    const cp = `${path}.content[${String(index)}]`;
    const childNode = assertObjectNode(child, cp);
    markSeen(state, childNode, cp);
    incrementNodes(state, cp);
    if (childNode.type !== "listItem") {
      throw new AdfParserError("UNKNOWN_NODE_TYPE", cp, `${kind} children must be listItem nodes`);
    }
    items.push(parseListItem(childNode, cp, depth + 1, state));
  });
  return { kind, items };
};

const parseParagraph = (
  node: Record<string, unknown>,
  path: string,
  depth: number,
  state: ParserState,
): IngestedBlock => {
  const inline = parseInlineContent(collectArrayContent(node), `${path}.content`, depth + 1, state);
  return { kind: "paragraph", runs: inline.runs };
};

function parseBlock(raw: unknown, path: string, depth: number, state: ParserState): IngestedBlock {
  const node = assertObjectNode(raw, path);
  markSeen(state, node, path);
  incrementNodes(state, path);
  checkDepth(state, depth, path);
  const type = getNodeType(node, path);
  switch (type) {
    case "paragraph":
      return parseParagraph(node, path, depth, state);
    case "heading":
      return parseHeading(node, path, depth, state);
    case "bulletList":
      return parseBulletOrOrderedList(node, path, depth, state, "bulletList");
    case "orderedList":
      return parseBulletOrOrderedList(node, path, depth, state, "orderedList");
    case "codeBlock":
      return parseCodeBlock(node, path, state);
    case "listItem":
      return parseListItem(node, path, depth, state);
    default:
      throw new AdfParserError(
        "UNKNOWN_NODE_TYPE",
        path,
        `Node type "${type}" is not a block-level node`,
      );
  }
}

/**
 * Parse a JSON-decoded ADF tree into an `IngestedDocument`. Throws `AdfParserError` for
 * unknown node types, malformed structure, depth-bombs, or circular references. Pure.
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
  const state: ParserState = {
    nodeCount: 0,
    maxDepthReached: 0,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxTextBytes: options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
    seen: new WeakSet(),
  };
  markSeen(state, raw, "$");
  incrementNodes(state, "$");
  const children = collectArrayContent(raw);
  const blocks: IngestedBlock[] = children.map((child, index) =>
    parseBlock(child, `$.content[${String(index)}]`, 1, state),
  );
  return {
    version: 1,
    blocks,
    stats: {
      nodes: state.nodeCount,
      maxDepthReached: state.maxDepthReached,
      truncatedBlocks: 0,
    },
  };
};

export const ADF_PARSER_DEFAULTS = {
  maxNodes: DEFAULT_MAX_NODES,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
} as const;
