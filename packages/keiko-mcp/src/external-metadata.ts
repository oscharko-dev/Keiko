import type { Transport } from "@modelcontextprotocol/client";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError } from "./definitions.js";

type JsonObject = Record<string, unknown>;
const MAX_TOOLS = 64;
const MAX_BYTES = 1024 * 1024;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/u;
const HEADER_TYPES: ReadonlySet<unknown> = new Set(["string", "integer", "boolean"]);
const SCHEMA_MAPS = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);
const OTHER_SCHEMAS = new Set([
  ...SCHEMA_MAPS,
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function jsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.length <= MAX_BYTES) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
interface Position {
  readonly value: unknown;
  readonly depth: number;
}
function plainJsonObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    prototype === null || prototype === (Array.isArray(value) ? Array.prototype : Object.prototype)
  );
}
function appendChildren(
  value: object,
  depth: number,
  pending: Position[],
  seen: Set<object>,
): boolean {
  if (!plainJsonObject(value) || seen.has(value)) return false;
  seen.add(value);
  const entries = Object.getOwnPropertyDescriptors(value);
  const values: unknown[] = [];
  for (const [key, descriptor] of Object.entries(entries)) {
    if (Array.isArray(value) && key === "length") continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
    values.push(descriptor.value);
  }
  if (values.length + pending.length > 8192) return false;
  for (const child of values) pending.push({ value: child, depth: depth + 1 });
  return true;
}
/** Bound the whole document before JSON serialization or any SDK recursive schema walk. */
function boundedMetadata(value: unknown): boolean {
  const pending: Position[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || ++count > 8192 || item.depth > 32) return false;
    if (item.value === null || typeof item.value !== "object") {
      if (!jsonScalar(item.value)) return false;
    } else if (!appendChildren(item.value, item.depth, pending, seen)) return false;
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BYTES;
}
interface SchemaPosition {
  readonly value: unknown;
  readonly reachable: boolean;
  readonly root: boolean;
}
function headerAdmitted(node: JsonObject, position: SchemaPosition, names: Set<string>): boolean {
  if (!Object.hasOwn(node, "x-mcp-header")) return true;
  const header = node["x-mcp-header"];
  if (
    !position.reachable ||
    position.root ||
    typeof header !== "string" ||
    !HEADER_TOKEN.test(header) ||
    !HEADER_TYPES.has(node.type)
  )
    return false;
  const name = header.toLowerCase();
  if (names.has(name)) return false;
  names.add(name);
  return true;
}
function schemaValues(key: string, child: unknown): readonly unknown[] {
  if (Array.isArray(child)) return child;
  return SCHEMA_MAPS.has(key) && object(child) ? Object.values(child) : [child];
}
function schemaChildren(node: JsonObject, position: SchemaPosition): SchemaPosition[] {
  const result: SchemaPosition[] = [];
  if (object(node.properties))
    for (const value of Object.values(node.properties))
      result.push({ value, reachable: position.reachable, root: false });
  for (const key of OTHER_SCHEMAS) {
    const child = node[key];
    if (child === undefined) continue;
    const children = schemaValues(key, child);
    for (const value of children) result.push({ value, reachable: false, root: false });
  }
  return result;
}
/** SEP-2243 admission only. Valid schemas are preserved exactly; no SDK-private scanner is called. */
function headersAdmitted(schema: JsonObject): boolean {
  const pending: SchemaPosition[] = [{ value: schema, reachable: true, root: true }];
  const names = new Set<string>();
  while (pending.length > 0) {
    const position = pending.pop();
    if (position === undefined || !object(position.value)) continue;
    if (position.value.properties !== undefined && !object(position.value.properties)) return false;
    if (!headerAdmitted(position.value, position, names)) return false;
    pending.push(...schemaChildren(position.value, position));
  }
  return true;
}
function toolAdmitted(tool: unknown): tool is JsonObject & { name: string } {
  return (
    object(tool) &&
    typeof tool.name === "string" &&
    tool.name.length > 0 &&
    tool.name.length <= 128 &&
    isBoundedExternalJsonSchema(tool.inputSchema) &&
    headersAdmitted(tool.inputSchema) &&
    (tool.outputSchema === undefined || isBoundedExternalJsonSchema(tool.outputSchema))
  );
}
export function admitExternalToolList(value: unknown): readonly string[] | undefined {
  if (
    !object(value) ||
    !boundedMetadata(value) ||
    !Array.isArray(value.tools) ||
    value.tools.length > MAX_TOOLS
  )
    return undefined;
  const names: string[] = [];
  for (const tool of value.tools) {
    if (!toolAdmitted(tool)) return undefined;
    names.push(tool.name);
  }
  return new Set(names).size === names.length ? names : undefined;
}
/** Protocol.connect chains this public hook synchronously before its own response parser/cache. */
export function installExternalMetadataAdmission(
  transport: Transport,
  reject: (error: ManagedMcpError) => void,
): void {
  const lists = new Set<string | number>();
  let refused = false;
  const names = new Set<string>();
  const send = transport.send.bind(transport);
  transport.send = (message, options): ReturnType<Transport["send"]> => {
    if ("method" in message && message.method === "tools/list" && "id" in message) {
      if (!object(message.params) || message.params.cursor === undefined) names.clear();
      lists.add(message.id);
    }
    return send(message, options);
  };
  transport.onmessage = (message): void => {
    if (refused) throw new ManagedMcpError("protocol-error");
    if (
      !("id" in message) ||
      message.id === undefined ||
      !lists.delete(message.id) ||
      !("result" in message)
    )
      return;
    const admitted = admitExternalToolList(message.result);
    if (
      admitted !== undefined &&
      names.size + admitted.length <= MAX_TOOLS &&
      admitted.every((name) => !names.has(name))
    ) {
      for (const name of admitted) names.add(name);
      return;
    }
    refused = true;
    const failure = new ManagedMcpError("protocol-error");
    reject(failure);
    throw failure;
  };
}
