import {
  CHANGESET_EDIT_ARGUMENT_LIMITS,
  GENERIC_TOOL_ARGUMENT_LIMITS,
  TOOL_CATALOG_LIMITS,
  type ToolArgumentLimits,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { requireCatalog, ToolCatalogError } from "./errors.js";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { GATEWAY_NATIVE_ADVERTISEMENT_CAPTURE_BYTES } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";

/** A whole native tool advertisement is captured with its own budget, never a call's (#3897). */
const MAX_ADVERTISEMENT_COPY_BYTES = GATEWAY_NATIVE_ADVERTISEMENT_CAPTURE_BYTES;

const ENCODER = new TextEncoder();
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
interface CopyBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly ancestors: Set<object>;
  bytes: number;
}

export function catalogBytes(value: CatalogJsonValue): number {
  return ENCODER.encode(JSON.stringify(value)).length;
}

function charge(budget: CopyBudget, text: string): void {
  budget.bytes += ENCODER.encode(text).length;
  requireCatalog(budget.bytes <= budget.maxBytes, "input-bound");
}

function scalar(value: unknown, budget: CopyBudget): CatalogJsonValue {
  requireCatalog(
    value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string",
    "invalid-shape",
  );
  if (typeof value === "number") requireCatalog(Number.isFinite(value), "invalid-shape");
  if (typeof value === "string")
    requireCatalog(ENCODER.encode(value).length <= budget.maxStringBytes, "input-bound");
  const result = value;
  charge(budget, JSON.stringify(result));
  return result;
}

function dataEntries(value: object): readonly (readonly [string, unknown])[] {
  const keys = Reflect.ownKeys(value);
  requireCatalog(
    keys.every((key) => typeof key === "string"),
    "invalid-shape",
  );
  return keys
    .map((key): readonly [string, unknown] => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireCatalog(descriptor !== undefined && "value" in descriptor, "invalid-shape");
      requireCatalog(descriptor.enumerable === true, "invalid-shape");
      requireCatalog(typeof key === "string" && !UNSAFE_KEYS.has(key), "invalid-shape");
      return [key, descriptor.value as unknown];
    })
    .sort(([left], [right]) => compareStrings(left, right));
}

function copyArray(value: unknown[], budget: CopyBudget, depth: number): CatalogJsonValue[] {
  requireCatalog(Object.getPrototypeOf(value) === Array.prototype, "invalid-shape");
  requireCatalog(value.length <= TOOL_CATALOG_LIMITS.maxArrayItems, "input-bound");
  requireCatalog(Reflect.ownKeys(value).length === value.length + 1, "invalid-shape");
  const copy: CatalogJsonValue[] = [];
  charge(budget, "[]");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireCatalog(
      descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true,
      "invalid-shape",
    );
    if (index > 0) charge(budget, ",");
    copy.push(copyValue(descriptor.value, budget, depth + 1));
  }
  return copy;
}

function copyObject(value: object, budget: CopyBudget, depth: number): CatalogJsonObject {
  const prototype: unknown = Object.getPrototypeOf(value);
  requireCatalog(prototype === null || prototype === Object.prototype, "invalid-shape");
  requireCatalog(Reflect.ownKeys(value).length <= TOOL_CATALOG_LIMITS.maxObjectKeys, "input-bound");
  const copy: Record<string, CatalogJsonValue> = Object.create(null) as Record<
    string,
    CatalogJsonValue
  >;
  charge(budget, "{}");
  let count = 0;
  for (const [key, child] of dataEntries(value)) {
    charge(budget, `${count++ === 0 ? "" : ","}${JSON.stringify(key)}:`);
    copy[key] = copyValue(child, budget, depth + 1);
  }
  return copy;
}

// Single return statement by design (sonarjs/function-return-type): the scalar and
// array/object arms both assign the same declared `CatalogJsonValue` union before one trailing
// return, rather than returning from inside each branch.
function copyValue(value: unknown, budget: CopyBudget, depth: number): CatalogJsonValue {
  requireCatalog(depth <= budget.maxDepth, "input-bound");
  let result: CatalogJsonValue;
  if (typeof value !== "object" || value === null) {
    result = scalar(value, budget);
  } else {
    requireCatalog(!budget.ancestors.has(value), "invalid-shape");
    budget.ancestors.add(value);
    result = Array.isArray(value)
      ? copyArray(value, budget, depth)
      : copyObject(value, budget, depth);
    budget.ancestors.delete(value);
  }
  return result;
}

/**
 * Validate and detach before canonicalization, freezing, hashing, or schema interpretation.
 * The contract's per-tool limits bound both the whole copy and each string; arbitrary caller
 * limits are refused. Ordinary values retain the schema depth, while envelopes alone add levels.
 */
export function copyCatalogJson(
  value: unknown,
  requestedBytes?: number,
  limits: ToolArgumentLimits = GENERIC_TOOL_ARGUMENT_LIMITS,
): CatalogJsonValue {
  return copyWithinBounds(value, requestedBytes, TOOL_CATALOG_LIMITS.maxSchemaDepth, limits);
}

/** Catalog/projection/binding wrappers add levels; descriptors are still independently qualified. */
export function copyCatalogEnvelope(value: unknown): CatalogJsonValue {
  return copyWithinBounds(
    value,
    TOOL_CATALOG_LIMITS.maxArgumentBytes,
    TOOL_CATALOG_LIMITS.maxSchemaDepth + 6,
    GENERIC_TOOL_ARGUMENT_LIMITS,
  );
}

function copyWithinBounds(
  value: unknown,
  requestedBytes: number | undefined,
  maxDepth: number,
  limits: ToolArgumentLimits,
): CatalogJsonValue {
  requireCatalog(
    limits === GENERIC_TOOL_ARGUMENT_LIMITS || limits === CHANGESET_EDIT_ARGUMENT_LIMITS,
    "input-bound",
  );
  const maxBytes = requestedBytes ?? limits.maxArgumentBytes;
  const ceiling =
    limits === GENERIC_TOOL_ARGUMENT_LIMITS
      ? Math.max(TOOL_CATALOG_LIMITS.maxResultBytes, MAX_ADVERTISEMENT_COPY_BYTES)
      : limits.maxArgumentBytes;
  requireCatalog(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= ceiling,
    "input-bound",
  );
  const { maxStringBytes } = limits;
  try {
    return copyValue(
      value,
      { maxBytes, maxDepth, maxStringBytes, ancestors: new Set(), bytes: 0 },
      1,
    );
  } catch (error) {
    if (error instanceof ToolCatalogError) throw error;
    throw new ToolCatalogError("invalid-shape");
  }
}

/** `Array.isArray` alone leaves a readonly array type in the union; this predicate removes it. */
export function isCatalogJsonArray(
  value: CatalogJsonValue | undefined,
): value is readonly CatalogJsonValue[] {
  return Array.isArray(value);
}

function jsonObject(value: CatalogJsonValue | undefined): CatalogJsonObject | undefined {
  return typeof value === "object" && value !== null && !isCatalogJsonArray(value)
    ? value
    : undefined;
}

export function catalogObject(value: CatalogJsonValue | undefined): CatalogJsonObject {
  const object = jsonObject(value);
  requireCatalog(object !== undefined, "invalid-shape");
  return object;
}

export function exactCatalogKeys(value: CatalogJsonObject, keys: readonly string[]): void {
  requireCatalog(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    "invalid-shape",
  );
}

function jsonString(value: CatalogJsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function catalogString(value: CatalogJsonValue | undefined): string {
  const text = jsonString(value);
  requireCatalog(text !== undefined && text.length > 0, "invalid-shape");
  return text;
}

export function catalogPositive(
  value: CatalogJsonValue | undefined,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  requireCatalog(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum,
    "invalid-shape",
  );
  return value;
}

export function catalogArray(value: CatalogJsonValue | undefined): readonly CatalogJsonValue[] {
  requireCatalog(isCatalogJsonArray(value), "invalid-shape");
  return value;
}

/** A provider tool call after `copyCatalogJson`: its identity strings and its argument object. */
export interface CatalogToolCall {
  readonly arguments: CatalogJsonObject;
  readonly id: string;
  readonly name: string;
}

/** The same call with the bound invocation it claims; the normalizer still verifies that claim. */
export interface BoundCatalogToolCall extends CatalogToolCall {
  readonly invocation: CatalogJsonValue;
}

const CALL_KEYS: readonly string[] = ["arguments", "id", "name"];
const BOUND_CALL_KEYS: readonly string[] = ["arguments", "id", "invocation", "name"];

function callObject(
  value: CatalogJsonValue,
  keys: readonly string[],
): CatalogJsonObject | undefined {
  const object = jsonObject(value);
  return object !== undefined &&
    Object.keys(object).length === keys.length &&
    keys.every((key) => Object.hasOwn(object, key))
    ? object
    : undefined;
}

// Keys are built in sorted order, the order `copyCatalogJson` gives its copy, so a call read here
// serializes exactly as the copy it was read from.
function callFields(object: CatalogJsonObject): CatalogToolCall | undefined {
  const args = jsonObject(object.arguments);
  const id = jsonString(object.id);
  const name = jsonString(object.name);
  return args !== undefined && id !== undefined && name !== undefined
    ? { arguments: args, id, name }
    : undefined;
}

/**
 * Reads a copied call with exactly `id`, `name` and `arguments`, or returns undefined for any other
 * shape. The caller applies its own id rule and its own rejection.
 */
export function readCatalogToolCall(value: CatalogJsonValue): CatalogToolCall | undefined {
  const object = callObject(value, CALL_KEYS);
  return object === undefined ? undefined : callFields(object);
}

/** As `readCatalogToolCall`, for a call that also carries exactly one `invocation`. */
export function readBoundCatalogToolCall(
  value: CatalogJsonValue,
): BoundCatalogToolCall | undefined {
  const object = callObject(value, BOUND_CALL_KEYS);
  const call = object === undefined ? undefined : callFields(object);
  const invocation = object?.invocation;
  return call === undefined || invocation === undefined
    ? undefined
    : { arguments: call.arguments, id: call.id, invocation, name: call.name };
}
