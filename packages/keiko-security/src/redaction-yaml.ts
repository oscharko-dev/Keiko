import { REDACTION_PLACEHOLDER } from "./redaction-source-map.js";
import { createRequire } from "node:module";
import type { Document, Node } from "yaml";
import type { ProjectionPorts, RedactionSpan } from "./redaction-code.js";
import { maskedLiteralBody } from "./redaction-typescript.js";

const requireYaml = createRequire(import.meta.url);
let parser: typeof import("yaml") | undefined;

function yamlApi(): typeof import("yaml") {
  parser ??= requireYaml("yaml") as typeof import("yaml");
  return parser;
}

export class YamlSyntaxRefusal extends Error {
  constructor() {
    super("YAML code projection is unavailable");
    this.name = "YamlSyntaxRefusal";
  }
}

export function mayStartYaml(text: string): boolean {
  const body = text.trimStart().replace(/^---[ \t]*\r?\n/u, "");
  const key = /^(?:[\w.-]+|"[^"\n]+"|'[^'\n]+')/u.exec(body);
  return key !== null && /^[ \t]*:(?:[ \t\r\n]|$)/u.test(body.slice(key[0].length));
}

export function isYamlDocument(text: string): boolean {
  const api = yamlApi();
  const document = api.parseDocument(text, { keepSourceTokens: true });
  return (
    (document.errors.length === 0 && complexYaml(document.contents, text)) ||
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
  const document = yamlApi().parseDocument(text, { keepSourceTokens: true });
  if (document.errors.length > 0) throw new YamlSyntaxRefusal();
  return document;
}

function scalarSpan(text: string, node: Node, replacement: string): RedactionSpan {
  const range = node.range;
  if (range === undefined || range === null) throw new YamlSyntaxRefusal();
  const raw = text.slice(range[0], range[1]);
  const lines = raw.match(/\r\n|\r|\n/gu)?.join("") ?? "";
  return { start: range[0], end: range[1], replacement: JSON.stringify(replacement) + lines };
}

interface YamlFrame {
  readonly value: unknown;
  readonly sensitive: boolean;
}

function yamlChildren(frame: YamlFrame, ports: ProjectionPorts): readonly YamlFrame[] {
  const api = yamlApi();
  if (api.isSeq(frame.value))
    return frame.value.items.map((value) => ({ value, sensitive: frame.sensitive }));
  if (!api.isMap(frame.value)) return [];
  return frame.value.items.flatMap((pair) => [
    { value: pair.key, sensitive: false },
    {
      value: pair.value,
      sensitive:
        frame.sensitive || (api.isScalar(pair.key) && ports.sensitiveName(String(pair.key.value))),
    },
  ]);
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
export function projectYamlData(text: string, ports: ProjectionPorts): readonly RedactionSpan[] {
  const api = yamlApi();
  const document = documentTree(text);
  const pending: YamlFrame[] = [{ value: document.contents, sensitive: false }];
  const visited = new Map<Node, boolean>();
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined || !api.isNode(frame.value)) continue;
    if (visited.get(frame.value) === true || visited.get(frame.value) === frame.sensitive) continue;
    visited.set(frame.value, frame.sensitive);
    if (canonicalPlaceholder(text, frame.value)) continue;
    if (api.isAlias(frame.value)) {
      pending.push({ value: frame.value.resolve(document), sensitive: frame.sensitive });
    } else pending.push(...yamlChildren(frame, ports));
  }
  return [...yamlScalarSpans(text, visited, ports), ...yamlCommentSpans(text, ports)];
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

function complexYaml(value: unknown, text: string): boolean {
  const api = yamlApi();
  if (api.isAlias(value) || api.isSeq(value)) return true;
  if (api.isScalar(value))
    return (
      value.anchor !== undefined ||
      (value.type !== undefined && value.type !== "PLAIN") ||
      (value.range !== undefined &&
        value.range !== null &&
        /[\r\n]/u.test(text.slice(value.range[0], value.range[1])))
    );
  return (
    api.isMap(value) &&
    value.items.some((pair) => complexYaml(pair.key, text) || complexYaml(pair.value, text))
  );
}

function yamlScalarSpans(
  text: string,
  nodes: ReadonlyMap<Node, boolean>,
  ports: ProjectionPorts,
): readonly RedactionSpan[] {
  const values = new Set(
    [...nodes]
      .filter(([node, sensitive]) => sensitive && yamlApi().isScalar(node))
      .map(([node]) => (yamlApi().isScalar(node) ? String(node.value) : "")),
  );
  const keys = yamlKeyNodes(nodes);
  const spans: RedactionSpan[] = [];
  for (const [node, sensitive] of nodes) {
    if (!yamlApi().isScalar(node)) continue;
    const value = String(node.value);
    const safe =
      sensitive || (!keys.has(node) && values.has(value))
        ? REDACTION_PLACEHOLDER
        : ports.redactPlain(value);
    if (safe !== value) spans.push(scalarSpan(text, node, safe));
  }
  return spans;
}

function canonicalPlaceholder(text: string, node: Node): boolean {
  const range = node.range;
  return (
    range !== undefined &&
    range !== null &&
    text.slice(range[0], range[1]) === REDACTION_PLACEHOLDER
  );
}

export function yamlPublicationNeedsContext(
  text: string,
  pendingLiteral: (value: string) => boolean,
): boolean {
  const api = yamlApi();
  const document = api.parseDocument(text, { keepSourceTokens: true });
  if (document.errors.length > 0 || complexYaml(document.contents, text)) return true;
  if (!api.isMap(document.contents)) return false;
  return document.contents.items.some((pair) => {
    if (!api.isScalar(pair.value)) return pair.value === null;
    if (pair.value.value === null) return true;
    return typeof pair.value.value === "string" && pendingLiteral(pair.value.value);
  });
}

function yamlKeyNodes(nodes: ReadonlyMap<Node, boolean>): ReadonlySet<Node> {
  const keys = new Set<Node>();
  for (const node of nodes.keys()) {
    if (!yamlApi().isMap(node)) continue;
    for (const pair of node.items) if (yamlApi().isNode(pair.key)) keys.add(pair.key);
  }
  return keys;
}
