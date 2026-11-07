import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraNativeText } from "./jira-native-values.js";

// Native EntityPropertyResource limits; the catalog's independent limits still apply.
// https://docs.atlassian.com/software/jira/docs/api/11.3.0/com/atlassian/jira/rest/v2/issue/IssuePropertyResource.html
export const JIRA_PROPERTY_KEY_MAX_BYTES = 255;
export const JIRA_PROPERTY_VALUE_MAX_BYTES = 32768;
type Refusal = "malformed-payload" | "bounds-exceeded";
interface Projection {
  readonly items: CatalogJsonObject[];
  readonly ancestors: Set<object>;
  bytes: number;
  refusal?: Refusal;
}
function propertyText(value: unknown, max: number, empty = false): value is string {
  return jiraNativeText(value, max, empty) && !/\p{Surrogate}/u.test(value);
}

/** Native observed keys are data, including keys the transport cannot safely address. */
export function jiraPropertyKey(value: unknown): value is string {
  return propertyText(value, JIRA_PROPERTY_KEY_MAX_BYTES) &&
    !/[\r\n\t]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= JIRA_PROPERTY_KEY_MAX_BYTES;
}
/** Match httpPort's encoded-separator/percent boundary before looking up any entity.
 * Dot segments must never normalize into another resource; the HTTP owner is unchanged.
 */
export function jiraPropertyPathKey(value: unknown): value is string {
  return jiraPropertyKey(value) && value !== "." && value !== ".." && !/[/\\%]/u.test(value);
}

function refuse(state: Projection, reason: Refusal): false {
  state.refusal = reason;
  return false;
}
function bytes(state: Projection, count: number): boolean {
  state.bytes += count;
  return state.bytes <= JIRA_PROPERTY_VALUE_MAX_BYTES || refuse(state, "bounds-exceeded");
}
function stringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function pointer(parent: string, key: string): string {
  return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
function stringNode(value: string, path: string, state: Projection): boolean {
  if (value.length > JIRA_PROPERTY_VALUE_MAX_BYTES) return refuse(state, "bounds-exceeded");
  if (!propertyText(value, JIRA_PROPERTY_VALUE_MAX_BYTES, true)) return refuse(state, "malformed-payload");
  state.items.push({ path, kind: "string", textValue: value });
  return bytes(state, stringBytes(value));
}
function numberNode(value: number, path: string, state: Projection): boolean {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    return refuse(state, "malformed-payload");
  state.items.push({ path, kind: "number", numberValue: value });
  return bytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"));
}
function scalar(value: unknown, path: string, state: Projection): boolean | undefined {
  if (value === null) {
    state.items.push({ path, kind: "null" });
    return bytes(state, 4);
  }
  switch (typeof value) {
    case "string": return stringNode(value, path, state);
    case "number": return numberNode(value, path, state);
    case "boolean":
      state.items.push({ path, kind: "boolean", booleanValue: value });
      return bytes(state, value ? 4 : 5);
    default: return undefined;
  }
}
function denseArray(value: readonly unknown[], keys: readonly string[]): boolean {
  return keys.length === value.length && keys.every((key, index) => key === String(index));
}
function containerKeys(value: object, state: Projection): readonly string[] | undefined {
  const array = Array.isArray(value);
  const keys = Object.keys(value);
  if (keys.length > (array ? TOOL_CATALOG_LIMITS.maxArrayItems : TOOL_CATALOG_LIMITS.maxObjectKeys)) {
    refuse(state, "bounds-exceeded");
    return undefined;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 ||
    (array && !denseArray(value, keys))) {
    refuse(state, "malformed-payload");
    return undefined;
  }
  return keys;
}
function child(value: object, key: string, path: string, depth: number, state: Projection): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) ||
    !propertyText(key, JIRA_PROPERTY_VALUE_MAX_BYTES, true))
    return refuse(state, "malformed-payload");
  if (!Array.isArray(value) && !bytes(state, stringBytes(key) + 1)) return false;
  return node(descriptor.value, pointer(path, key), depth + 1, state);
}
function children(value: object, path: string, depth: number, state: Projection): boolean {
  const keys = containerKeys(value, state);
  if (keys === undefined) return false;
  state.items.push({ path, kind: Array.isArray(value) ? "array" : "object", childCount: keys.length });
  if (!bytes(state, 2 + Math.max(0, keys.length - 1))) return false;
  for (const key of keys) {
    if (!child(value, key, path, depth, state)) return false;
  }
  return true;
}
function plainContainer(value: unknown, state: Projection): value is object {
  if (typeof value !== "object" || value === null || state.ancestors.has(value)) return false;
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function node(value: unknown, path: string, depth: number, state: Projection): boolean {
  if (depth > TOOL_CATALOG_LIMITS.maxSchemaDepth ||
    state.items.length >= TOOL_CATALOG_LIMITS.maxArrayItems ||
    Buffer.byteLength(path, "utf8") > JIRA_PROPERTY_VALUE_MAX_BYTES)
    return refuse(state, "bounds-exceeded");
  const primitive = scalar(value, path, state);
  if (primitive !== undefined) return primitive;
  if (!plainContainer(value, state)) return refuse(state, "malformed-payload");
  state.ancestors.add(value);
  const accepted = children(value, path, depth, state);
  state.ancestors.delete(value);
  return accepted;
}

/** Native REST emits JSON values, not JSON-encoded strings. Never parse a text leaf again.
 * JSON Pointer's empty root and escaped tokens preserve empty, slash and tilde object keys.
 * A value is returned in full or refused; no prefix can masquerade as the stored property.
 */
export function jiraPropertyValue(value: unknown):
  | { readonly ok: true; readonly items: readonly CatalogJsonObject[] }
  | { readonly ok: false; readonly reason: Refusal } {
  const state: Projection = { items: [], ancestors: new Set(), bytes: 0 };
  return node(value, "", 0, state)
    ? { ok: true, items: state.items }
    : { ok: false, reason: state.refusal ?? "malformed-payload" };
}
