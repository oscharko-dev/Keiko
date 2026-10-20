import { REDACTION_PLACEHOLDER } from "./redaction-source-map.js";
import { createRequire } from "node:module";
import type { Document, Node, Scalar } from "yaml";
import type { ProjectionPorts, RedactionSpan } from "./redaction-code.js";
import { maskedLiteralBody } from "./redaction-typescript.js";

const requireYaml = createRequire(import.meta.url);
let parser: typeof import("yaml") | undefined;

function yamlApi(): typeof import("yaml") {
  parser ??= requireYaml("yaml") as typeof import("yaml");
  return parser;
}

function parsePrivacyDocument(text: string): Document {
  return yamlApi().parseDocument(text, { keepSourceTokens: true, uniqueKeys: false });
}

export function isPublicYamlScalar(text: string, ports: ProjectionPorts): boolean {
  const document = parsePrivacyDocument(text);
  const scalar = document.contents;
  if (document.errors.length > 0 || !yamlApi().isScalar(scalar) || scalar.value === null)
    return false;
  const value = scalar.value;
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean" &&
    typeof value !== "bigint"
  )
    return false;
  return ports.redactPlain(String(value)) === String(value);
}

function duplicateMapKeys(value: unknown): boolean {
  const api = yamlApi();
  if (!api.isMap(value)) return false;
  const nodes = new Set<unknown>();
  const values = new Set<unknown>();
  for (const pair of value.items) {
    if (nodes.has(pair.key)) return true;
    nodes.add(pair.key);
    if (!api.isScalar(pair.key) || Number.isNaN(pair.key.value)) continue;
    if (values.has(pair.key.value)) return true;
    values.add(pair.key.value);
  }
  return false;
}

function hasDuplicateKeys(value: unknown): boolean {
  const api = yamlApi();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (api.isMap(node)) {
      if (duplicateMapKeys(node)) return true;
      for (const pair of node.items) pending.push(pair.key, pair.value);
    } else if (api.isSeq(node)) {
      for (const item of node.items) pending.push(item);
    }
  }
  return false;
}

export class YamlSyntaxRefusal extends Error {
  constructor() {
    super("YAML code projection is unavailable");
    this.name = "YamlSyntaxRefusal";
  }
}

export function mayStartYaml(text: string): boolean {
  const body = text.trimStart().replace(/^---[ \t]*\r?\n/u, "");
  if (/^(?:&\S|\?[ \t]+|\*[^\s]+[ \t]*:)/u.test(body)) return true;
  const key = /^(?:[\w.-]+|"[^"\n]+"|'[^'\n]+')/u.exec(body);
  return key !== null && /^[ \t]*:(?:[ \t\r\n]|$)/u.test(body.slice(key[0].length));
}

export function isYamlDocument(text: string): boolean {
  const document = parsePrivacyDocument(text);
  return (
    (document.errors.length === 0 &&
      !hasDuplicateKeys(document.contents) &&
      complexYaml(document.contents, text)) ||
    hasBlockScalarHeader(text)
  );
}

/** Scan each line and header once. A comment's near-miss terminator must not cause every
 * preceding candidate to rescan the same remaining body. Preserve the original dot boundaries. */
function hasBlockScalarHeader(text: string): boolean {
  let start = 0;
  for (const ending of text.matchAll(/[\r\n\u2028\u2029]/gu)) {
    const end = ending.index;
    const validEnding = ending[0] === "\n" || text.slice(end, end + 2) === "\r\n";
    if (validEnding && hasHeaderBeforeLineEnd(text.slice(start, end))) return true;
    start = end + 1;
  }
  return hasHeaderBeforeLineEnd(text.slice(start));
}

function hasHeaderBeforeLineEnd(line: string): boolean {
  for (const header of line.matchAll(/:[ \t]*[|>][+\d-]*[ \t]*/gu)) {
    const end = header.index + header[0].length;
    if (end === line.length || line.charAt(end) === "#") return true;
  }
  return false;
}

function documentTree(text: string): Document {
  const document = parsePrivacyDocument(text);
  if (document.errors.length > 0 || hasDuplicateKeys(document.contents))
    throw new YamlSyntaxRefusal();
  return document;
}

/** A privacy context preserves every mapping entry; it does not validate configuration uniqueness. */
export function yamlPrivacyPrefix(
  text: string,
  sourceTransition: (line: string) => boolean,
  sensitiveName: (name: string) => boolean,
):
  | {
      readonly end: number;
      readonly document?: Document;
      readonly syntaxRequired?: boolean;
      readonly privateKeyObserved?: boolean;
    }
  | undefined {
  const document = parsePrivacyDocument(text);
  const end = privacyBoundary(text, document, sourceTransition);
  if (end <= 0) return undefined;
  const prefix = end === text.length ? document : parsePrivacyDocument(text.slice(0, end));
  if (prefix.errors.length > 0 || !yamlApi().isMap(prefix.contents))
    return {
      end,
      syntaxRequired: complexYaml(prefix.contents, text.slice(0, end), true, false),
      privateKeyObserved: malformedYamlHasPrivateKey(prefix, sensitiveName),
    };
  if (end < (document.range?.[2] ?? text.length) && hasPendingPrivateValue(prefix, sensitiveName))
    return {
      end,
      syntaxRequired: complexYaml(prefix.contents, text.slice(0, end), true, false),
      privateKeyObserved: true,
    };
  return { end, document: prefix };
}

function malformedYamlHasPrivateKey(
  document: Document,
  sensitiveName: (name: string) => boolean,
): boolean {
  let aliases: ReadonlyMap<Node, Node>;
  try {
    aliases = yamlAliasTargets(document);
  } catch (error) {
    if (error instanceof YamlSyntaxRefusal) return true;
    throw error;
  }
  const api = yamlApi();
  const pending: unknown[] = [];
  api.visit(document, {
    Map: (_key, map): void => {
      for (const pair of map.items) pending.push(pair.key);
    },
  });
  const seen = new Set<Node>();
  while (pending.length > 0) {
    const key = pending.pop();
    if (!api.isNode(key) || seen.has(key)) continue;
    seen.add(key);
    if (api.isScalar(key) && sensitiveName(String(key.value))) return true;
    appendYamlKeyChildren(key, pending, aliases);
  }
  return false;
}

function appendYamlKeyChildren(
  key: Node,
  pending: unknown[],
  aliases: ReadonlyMap<Node, Node>,
): void {
  const api = yamlApi();
  if (api.isAlias(key)) pending.push(aliases.get(key));
  else if (api.isSeq(key)) pending.push(...key.items);
  else if (api.isMap(key)) for (const pair of key.items) pending.push(pair.key, pair.value);
}

function hasPendingPrivateValue(
  document: Document,
  sensitiveName: (name: string) => boolean,
): boolean {
  const api = yamlApi();
  return (
    api.isMap(document.contents) &&
    document.contents.items.some(
      (pair) =>
        api.isScalar(pair.key) &&
        sensitiveName(String(pair.key.value)) &&
        api.isScalar(pair.value) &&
        pair.value.value === null,
    )
  );
}

function rootKeyLine(text: string, key: unknown): { start: number; line: string } | undefined {
  if (!yamlApi().isNode(key) || key.range === undefined || key.range === null) return undefined;
  const start = text.lastIndexOf("\n", key.range[0] - 1) + 1;
  const newline = text.indexOf("\n", key.range[0]);
  return { start, line: text.slice(start, newline < 0 ? text.length : newline) };
}

function privacyBoundary(
  text: string,
  document: Document,
  sourceTransition: (line: string) => boolean,
): number {
  if (!yamlApi().isMap(document.contents)) return 0;
  let end = document.range?.[2] ?? text.length;
  for (const pair of document.contents.items) {
    const source = rootKeyLine(text, pair.key);
    if (source === undefined) continue;
    const malformedKey = document.errors.length > 0 && pair.value === null;
    if (!mayStartYaml(source.line) && (sourceTransition(source.line) || malformedKey))
      end = Math.min(end, source.start);
  }
  return end;
}

function scalarSpan(text: string, node: Node, replacement: string, plain: boolean): RedactionSpan {
  const range = node.range;
  if (range === undefined || range === null) throw new YamlSyntaxRefusal();
  const raw = text.slice(range[0], range[1]);
  const lines = raw.match(/\r\n|\r|\n/gu)?.join("") ?? "";
  return {
    start: range[0],
    end: range[1],
    replacement: (plain ? replacement : JSON.stringify(replacement)) + lines,
  };
}

interface YamlFrame {
  readonly value: unknown;
  readonly sensitive: boolean;
}

/** Canonical parser order binds each alias to its nearest preceding anchor without expansion. */
function yamlAliasTargets(document: Document): ReadonlyMap<Node, Node> {
  const api = yamlApi();
  const anchors = new Map<string, Node>();
  const targets = new Map<Node, Node>();
  api.visit(document, {
    Node: (_key, node): void => {
      if (!api.isAlias(node)) {
        if (node.anchor !== undefined && node.anchor !== "") anchors.set(node.anchor, node);
        return;
      }
      const target = anchors.get(node.source);
      if (target === undefined) throw new YamlSyntaxRefusal();
      targets.set(node, target);
    },
  });
  return targets;
}

function yamlChildren(
  frame: YamlFrame,
  ports: ProjectionPorts,
  aliases: ReadonlyMap<Node, Node>,
): readonly YamlFrame[] {
  const api = yamlApi();
  if (api.isSeq(frame.value))
    return frame.value.items.map((value) => ({ value, sensitive: frame.sensitive }));
  if (!api.isMap(frame.value)) return [];
  return frame.value.items.flatMap((pair): YamlFrame[] => {
    const key = api.isAlias(pair.key) ? aliases.get(pair.key) : pair.key;
    return [
      { value: pair.key, sensitive: false },
      {
        value: pair.value,
        sensitive: frame.sensitive || (api.isScalar(key) && ports.sensitiveName(String(key.value))),
      },
    ];
  });
}

function yamlCommentSpans(text: string, ports: ProjectionPorts): readonly RedactionSpan[] {
  const pending: unknown[] = [...new (yamlApi().Parser)().parse(text)];
  const spans: RedactionSpan[] = [];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    const span = yamlCommentSpan(value, ports);
    if (span !== undefined) spans.push(span);
    else {
      const fields: unknown[] = Object.values(value);
      pending.push(...fields);
    }
  }
  return spans;
}

/** Parsed scalar ranges protect escaped and block values without reserializing the document. */
export function projectYamlData(
  text: string,
  ports: ProjectionPorts,
  privacyDocument?: Document,
): readonly RedactionSpan[] {
  const api = yamlApi();
  const document = privacyDocument ?? documentTree(text);
  if (document.errors.length > 0) throw new YamlSyntaxRefusal();
  const aliases = yamlAliasTargets(document);
  const pending: YamlFrame[] = [{ value: document.contents, sensitive: false }];
  const visited = new Map<Node, boolean>();
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined || !api.isNode(frame.value)) continue;
    if (visited.get(frame.value) === true || visited.get(frame.value) === frame.sensitive) continue;
    visited.set(frame.value, frame.sensitive);
    if (canonicalPlaceholder(text, frame.value)) continue;
    if (api.isAlias(frame.value)) {
      pending.push({ value: aliases.get(frame.value), sensitive: frame.sensitive });
    } else appendYamlChildren(pending, frame, ports, aliases);
  }
  const plain = inferredPlainScalars(document, privacyDocument, text);
  return [...yamlScalarSpans(text, visited, ports, plain), ...yamlCommentSpans(text, ports)];
}

function inferredPlainScalars(
  document: Document,
  privacyDocument: Document | undefined,
  text: string,
): boolean {
  return privacyDocument !== undefined && !complexYaml(document.contents, text, true);
}

function appendYamlChildren(
  pending: YamlFrame[],
  frame: YamlFrame,
  ports: ProjectionPorts,
  aliases: ReadonlyMap<Node, Node>,
): void {
  for (const child of yamlChildren(frame, ports, aliases)) pending.push(child);
}

function yamlCommentSpan(value: object, ports: ProjectionPorts): RedactionSpan | undefined {
  if (
    !("type" in value) ||
    value.type !== "comment" ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !("offset" in value) ||
    typeof value.offset !== "number"
  )
    return undefined;
  return ports.redactPlain(value.source) === value.source
    ? undefined
    : {
        start: value.offset + 1,
        end: value.offset + value.source.length,
        replacement: maskedLiteralBody(value.source.slice(1)),
      };
}

function complexYaml(
  value: unknown,
  text: string,
  includeFlow = false,
  includePlainMultiline = true,
): boolean {
  const api = yamlApi();
  if (api.isNode(value) && canonicalPlaceholder(text, value)) return false;
  if (api.isAlias(value) || api.isSeq(value)) return true;
  if (api.isScalar(value)) return complexYamlScalar(value, text, includePlainMultiline);
  return complexYamlMap(value, text, includeFlow, includePlainMultiline);
}

function complexYamlScalar(value: Scalar, text: string, includePlainMultiline: boolean): boolean {
  return (
    value.anchor !== undefined ||
    (value.type !== undefined && value.type !== "PLAIN") ||
    (includePlainMultiline &&
      value.range !== undefined &&
      value.range !== null &&
      /[\r\n]/u.test(text.slice(value.range[0], value.range[1])))
  );
}

function complexYamlMap(
  value: unknown,
  text: string,
  includeFlow: boolean,
  includePlainMultiline: boolean,
): boolean {
  return (
    yamlApi().isMap(value) &&
    ((includeFlow && value.flow === true) ||
      value.items.some(
        (pair) =>
          complexYaml(pair.key, text, includeFlow, includePlainMultiline) ||
          complexYaml(pair.value, text, includeFlow, includePlainMultiline),
      ))
  );
}

function yamlScalarSpans(
  text: string,
  nodes: ReadonlyMap<Node, boolean>,
  ports: ProjectionPorts,
  plain: boolean,
): readonly RedactionSpan[] {
  const values = new Set(
    [...nodes]
      .filter(([node, sensitive]) => sensitive && yamlApi().isScalar(node))
      .map(([node]) => (yamlApi().isScalar(node) ? String(node.value) : "")),
  );
  const keys = yamlKeyNodes(nodes);
  recordPrivateYamlValues(nodes, ports);
  const spans: RedactionSpan[] = [];
  for (const [node, sensitive] of nodes) {
    if (!yamlApi().isScalar(node)) continue;
    const value = String(node.value);
    const safe =
      sensitive || (!keys.has(node) && knownYamlValue(node, values, ports))
        ? REDACTION_PLACEHOLDER
        : ports.redactPlain(value);
    if (safe !== value) spans.push(scalarSpan(text, node, safe, plain));
  }
  return spans;
}

function recordPrivateYamlValues(nodes: ReadonlyMap<Node, boolean>, ports: ProjectionPorts): void {
  for (const [node, sensitive] of nodes)
    if (sensitive && yamlApi().isScalar(node))
      ports.privateLiteralValues?.add(sharedYamlLiteralKey(node));
}

function knownYamlValue(
  node: Scalar,
  values: ReadonlySet<string>,
  ports: ProjectionPorts,
): boolean {
  return (
    values.has(String(node.value)) ||
    ports.privateLiteralValues?.has(sharedYamlLiteralKey(node)) === true
  );
}

function sharedYamlLiteralKey(node: Scalar): string {
  return `${typeof node.value}:${String(node.value)}`;
}

function canonicalPlaceholder(text: string, node: Node): boolean {
  const range = node.range;
  return (
    range !== undefined &&
    range !== null &&
    text.slice(range[0], range[1]) === REDACTION_PLACEHOLDER
  );
}

export function yamlPublicationNeedsContext(text: string): boolean {
  const api = yamlApi();
  const document = parsePrivacyDocument(text);
  return (
    document.errors.length > 0 ||
    api.isMap(document.contents) ||
    complexYaml(document.contents, text)
  );
}

function yamlKeyNodes(nodes: ReadonlyMap<Node, boolean>): ReadonlySet<Node> {
  const keys = new Set<Node>();
  for (const node of nodes.keys()) {
    if (!yamlApi().isMap(node)) continue;
    for (const pair of node.items) if (yamlApi().isNode(pair.key)) keys.add(pair.key);
  }
  return keys;
}
