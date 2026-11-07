import { TOOL_CATALOG_LIMITS, type CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { JIRA_PROPERTY_VALUE_MAX_BYTES, jiraPropertyValue } from "./jira-entity-property-values.js";

type FailureReason = "invalid-input" | "bounds-exceeded";
type Node =
  | { readonly path: string; readonly kind: "null" }
  | { readonly path: string; readonly kind: "boolean"; readonly booleanValue: boolean }
  | { readonly path: string; readonly kind: "number"; readonly numberValue: number }
  | { readonly path: string; readonly kind: "string"; readonly textValue: string }
  | { readonly path: string; readonly kind: "array" | "object"; readonly childCount: number };
interface Reader {
  readonly nodes: readonly Node[];
  cursor: number;
  failure?: FailureReason;
}
export type JiraPropertyInput =
  | { readonly ok: true; readonly value: CatalogJsonValue }
  | { readonly ok: false; readonly reason: FailureReason };
const INVALID = { ok: false, reason: "invalid-input" } as const;
const BOUNDS = { ok: false, reason: "bounds-exceeded" } as const;
const NODE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["null", ["path", "kind"]],
  ["boolean", ["path", "kind", "booleanValue"]],
  ["number", ["path", "kind", "numberValue"]],
  ["string", ["path", "kind", "textValue"]],
  ["array", ["path", "kind", "childCount"]],
  ["object", ["path", "kind", "childCount"]],
]);

function dataFields(value: object, keys: readonly PropertyKey[]): Record<string, unknown> | undefined {
  const fields: [string, unknown][] = [];
  for (const key of keys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    const field: unknown = descriptor.value;
    fields.push([key, field]);
  }
  return Object.fromEntries(fields);
}
/** Read only own data descriptors. Accessors, inherited fields and symbols are not JSON input. */
function ownFields(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  // A node has path/kind and at most one kind-specific value; reject extras before copying them.
  return keys.length <= 3 ? dataFields(value, keys) : undefined;
}
function exact(raw: Record<string, unknown>): boolean {
  const expected = typeof raw.kind === "string" ? NODE_FIELDS.get(raw.kind) : undefined;
  return expected !== undefined && Object.keys(raw).length === expected.length &&
    expected.every((key) => Object.hasOwn(raw, key));
}
function scalar(raw: Record<string, unknown>, path: string): Node | undefined {
  switch (raw.kind) {
    case "null": return { path, kind: "null" };
    case "boolean": return typeof raw.booleanValue === "boolean"
      ? { path, kind: "boolean", booleanValue: raw.booleanValue } : undefined;
    case "number": return typeof raw.numberValue === "number"
      ? { path, kind: "number", numberValue: raw.numberValue } : undefined;
    case "string": return typeof raw.textValue === "string"
      ? { path, kind: "string", textValue: raw.textValue } : undefined;
    default: return undefined;
  }
}
function node(value: unknown): Node | undefined {
  const raw = ownFields(value);
  if (raw === undefined || typeof raw.path !== "string" || !exact(raw)) return undefined;
  if (raw.kind !== "array" && raw.kind !== "object") return scalar(raw, raw.path);
  if (typeof raw.childCount !== "number" ||
    !Number.isSafeInteger(raw.childCount) || raw.childCount < 0) return undefined;
  return { path: raw.path, kind: raw.kind, childCount: raw.childCount };
}
function nodeExceedsBounds(value: Node): boolean {
  if (value.path.length > JIRA_PROPERTY_VALUE_MAX_BYTES) return true;
  if (value.kind === "object") return value.childCount > TOOL_CATALOG_LIMITS.maxObjectKeys;
  return value.kind === "array" && value.childCount > TOOL_CATALOG_LIMITS.maxArrayItems;
}
function inputNodes(value: readonly unknown[]):
  | { readonly ok: true; readonly nodes: readonly Node[] }
  | Extract<JiraPropertyInput, { readonly ok: false }> {
  if (Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== value.length + 1) return INVALID;
  const output: Node[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return INVALID;
    const input: unknown = descriptor.value;
    const parsed = node(input);
    if (parsed === undefined) return INVALID;
    if (nodeExceedsBounds(parsed)) return BOUNDS;
    output.push(parsed);
  }
  return { ok: true, nodes: output };
}
function refuse(state: Reader, reason: FailureReason = "invalid-input"): undefined {
  state.failure = reason;
  return undefined;
}
function directObjectKey(path: string, parent: string): string | undefined {
  const prefix = `${parent}/`;
  if (!path.startsWith(prefix)) return undefined;
  const token = path.slice(prefix.length);
  if (token.includes("/") || /~(?:[^01]|$)/u.test(token)) return undefined;
  const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
  return key.replaceAll("~", "~0").replaceAll("/", "~1") === token ? key : undefined;
}
function arrayValue(node: Extract<Node, { readonly kind: "array" | "object" }>, state: Reader, depth: number): CatalogJsonValue | undefined {
  const output: CatalogJsonValue[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const value = readValue(state, `${node.path}/${index}`, depth + 1);
    if (value === undefined) return undefined;
    output.push(value);
  }
  return output;
}
function objectValue(node: Extract<Node, { readonly kind: "array" | "object" }>, state: Reader, depth: number): CatalogJsonValue | undefined {
  const output: Record<string, CatalogJsonValue> = {};
  for (let index = 0; index < node.childCount; index++) {
    const next = state.nodes[state.cursor];
    if (next === undefined) return refuse(state);
    const key = directObjectKey(next.path, node.path);
    if (key === undefined || Object.hasOwn(output, key)) return refuse(state);
    const value = readValue(state, next.path, depth + 1);
    if (value === undefined) return undefined;
    // Define an own data field even for __proto__; never invoke Object.prototype's setter.
    Object.defineProperty(output, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return output;
}
function readValue(state: Reader, expectedPath: string, depth: number): CatalogJsonValue | undefined {
  if (depth > TOOL_CATALOG_LIMITS.maxSchemaDepth) return refuse(state, "bounds-exceeded");
  const current = state.nodes[state.cursor];
  if (current === undefined || current.path !== expectedPath) return refuse(state);
  state.cursor++;
  switch (current.kind) {
    case "null": return null;
    case "boolean": return current.booleanValue;
    case "number": return current.numberValue;
    case "string": return current.textValue;
    case "array": return arrayValue(current, state, depth);
    case "object": return objectValue(current, state, depth);
  }
}

/** Invert the existing typed JSON Pointer projection; strings remain literal data, never JSON source. */
export function decodeJiraPropertyInput(input: unknown): JiraPropertyInput {
  if (!Array.isArray(input) || input.length === 0) return INVALID;
  if (input.length > TOOL_CATALOG_LIMITS.maxArrayItems) return BOUNDS;
  const selected = inputNodes(input);
  if (!selected.ok) return selected;
  const state: Reader = { nodes: selected.nodes, cursor: 0 };
  const value = readValue(state, "", 0);
  if (value === undefined || state.cursor !== selected.nodes.length)
    return { ok: false, reason: state.failure ?? "invalid-input" };
  // The established projector owns native UTF-8 bytes, Unicode, JSON numbers and catalog limits.
  const admitted = jiraPropertyValue(value);
  return admitted.ok ? { ok: true, value }
    : { ok: false, reason: admitted.reason === "bounds-exceeded" ? "bounds-exceeded" : "invalid-input" };
}
