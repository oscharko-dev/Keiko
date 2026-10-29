import type { CatalogJsonObject } from "./governed-tool-catalog.js";
import { regexSafetyIssue } from "./workspace-search.js";

export const EXTERNAL_JSON_SCHEMA_DEFAULT = "https://json-schema.org/draft/2020-12/schema";
const DIALECTS = new Set([
  EXTERNAL_JSON_SCHEMA_DEFAULT,
  "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft-07/schema#",
]);
const MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const CHILDREN = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
  "items",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
const FORBIDDEN = new Set([
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "$async",
]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ENCODER = new TextEncoder();

interface Budget {
  bytes: number;
  nodes: number;
  readonly ancestors: Set<object>;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedEntries(value: object): readonly [string, unknown][] | undefined {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128) return undefined;
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    if (typeof key !== "string" || UNSAFE_KEYS.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return undefined;
    entries.push([key, descriptor.value as unknown]);
  }
  return entries;
}
function scalar(value: unknown): value is null | boolean | string | number {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  );
}
function array(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
// One fully anchored character atom cannot backtrack across competing repetitions. Keep this
// exception deliberately smaller than JavaScript's regex grammar; all other patterns use the
// shared search safety gate, and the original expression is never transformed.
const SINGLE_CHARACTER_ATOM =
  /^\^(\[[A-Za-z0-9_-]{1,120}\]|\\[dDsSwW])(?:[+*?]|\{(\d{1,6})(?:,(\d{0,6}))?\})?\$$/u;
function orderedCharacterRanges(atom: string): boolean {
  if (!atom.startsWith("[")) return true;
  const characters = atom.slice(1, -1);
  for (let index = 1; index < characters.length - 1; index++) {
    if (characters[index] === "-" && (characters[index - 1] ?? "") > (characters[index + 1] ?? ""))
      return false;
  }
  return true;
}
function linearCharacterPattern(value: string): boolean {
  if (value.length > 256) return false;
  const match = SINGLE_CHARACTER_ATOM.exec(value);
  if (match === null || !orderedCharacterRanges(match[1] ?? "")) return false;
  const minimum = match[2];
  const maximum = match[3];
  return (
    minimum === undefined ||
    maximum === undefined ||
    maximum === "" ||
    Number(minimum) <= Number(maximum)
  );
}
function safePattern(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      (regexSafetyIssue(value) === undefined || linearCharacterPattern(value)))
  );
}
function boundedJson(value: unknown, depth: number, budget: Budget): boolean {
  if (++budget.nodes > 2048 || depth > 16) return false;
  if (scalar(value)) {
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    budget.bytes += ENCODER.encode(JSON.stringify(value)).length;
    return budget.bytes <= 65_536;
  }
  if (typeof value !== "object" || budget.ancestors.has(value)) return false;
  budget.ancestors.add(value);
  budget.bytes += 2;
  const valid = Array.isArray(value)
    ? boundedArray(value, depth, budget)
    : boundedObject(value, depth, budget);
  budget.ancestors.delete(value);
  return valid;
}
function boundedArray(value: unknown[], depth: number, budget: Budget): boolean {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 128 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return false;
    budget.bytes++;
    if (!boundedJson(descriptor.value, depth + 1, budget)) return false;
  }
  return budget.bytes <= 65_536;
}
function boundedObject(value: object, depth: number, budget: Budget): boolean {
  const entries = boundedEntries(value);
  if (entries === undefined) return false;
  for (const [key, child] of entries) {
    budget.bytes += ENCODER.encode(JSON.stringify(key)).length + 2;
    if (!boundedJson(child, depth + 1, budget)) return false;
  }
  return budget.bytes <= 65_536;
}
function schemaChildren(key: string, value: unknown): readonly unknown[] {
  if (MAPS.has(key) && object(value)) return Object.values(value);
  if (LISTS.has(key) && array(value)) return value;
  if (CHILDREN.has(key)) return array(value) ? value : [value];
  if (key === "dependencies" && object(value))
    return Object.values(value).filter((entry) => !array(entry));
  return [];
}
function childrenOf(schema: Record<string, unknown>): readonly unknown[] | undefined {
  const children: unknown[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (FORBIDDEN.has(key)) return undefined;
    if (
      key === "patternProperties" &&
      object(value) &&
      Object.keys(value).some((pattern) => !safePattern(pattern))
    )
      return undefined;
    children.push(...schemaChildren(key, value));
  }
  return children;
}
function collectSchemas(
  schema: unknown,
  root: object,
  graph: Map<object, readonly unknown[]>,
): boolean {
  if (typeof schema === "boolean") return true;
  if (!object(schema) || graph.size >= 256 || (schema !== root && schema.$schema !== undefined))
    return false;
  if (!safePattern(schema.pattern)) return false;
  // The regex format compiles model-controlled data as a pattern in some validators.
  if (schema.format === "regex") return false;
  const children = childrenOf(schema);
  if (children === undefined) return false;
  graph.set(schema, children);
  return children.every((child) => collectSchemas(child, root, graph));
}
function resolveReference(root: unknown, reference: unknown): unknown {
  if (reference === "#") return root;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const encoded of decodeURIComponent(reference.slice(2)).split("/")) {
    if (/~(?:[^01]|$)/u.test(encoded)) return undefined;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key))
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function finiteSchemaGraph(root: object, graph: Map<object, readonly unknown[]>): boolean {
  for (const [schema, children] of graph) {
    const reference = (schema as Record<string, unknown>).$ref;
    if (reference === undefined) continue;
    const target = resolveReference(root, reference);
    if (typeof target !== "boolean" && (!object(target) || !graph.has(target))) return false;
    graph.set(schema, [...children, target]);
  }
  const seen = new Set<object>();
  const costs = new Map<object, { depth: number; work: number }>();
  const cost = (value: unknown): { depth: number; work: number } => {
    if (typeof value === "boolean") return { depth: 0, work: 1 };
    if (!object(value) || seen.has(value)) return { depth: Infinity, work: Infinity };
    const known = costs.get(value);
    if (known !== undefined) return known;
    seen.add(value);
    const children = (graph.get(value) ?? []).map(cost);
    const result = {
      depth: 1 + Math.max(0, ...children.map((child) => child.depth)),
      work: 1 + children.reduce((sum, child) => sum + child.work, 0),
    };
    seen.delete(value);
    costs.set(value, result);
    return result;
  };
  const total = cost(root);
  return total.depth <= 16 && total.work <= 2048;
}

/** Safety admission before any external schema reaches a compiler or executes a regex. */
export function isBoundedExternalJsonSchema(value: unknown): value is CatalogJsonObject {
  try {
    if (!object(value) || !boundedJson(value, 1, { bytes: 0, nodes: 0, ancestors: new Set() }))
      return false;
    if (
      value.$schema !== undefined &&
      (typeof value.$schema !== "string" || !DIALECTS.has(value.$schema))
    )
      return false;
    const graph = new Map<object, readonly unknown[]>();
    return collectSchemas(value, value, graph) && finiteSchemaGraph(value, graph);
  } catch {
    // Pure contracts cannot log. Propagate unexpected JS/URI failures to the consumer's
    // registered admission failure boundary without carrying any schema content.
    throw new TypeError("Invalid external JSON schema");
  }
}

export function isExternalJsonSchemaDialect(value: unknown): value is string {
  return typeof value === "string" && DIALECTS.has(value);
}
