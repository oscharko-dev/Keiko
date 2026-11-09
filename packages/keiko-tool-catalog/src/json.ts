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
/** What a bounded copy of a value charges: bytes, deepest level (the root is 1), longest string. */
export interface CatalogFootprint {
  readonly bytes: number;
  readonly depth: number;
  readonly longestString: number;
}
/** Vouches for a value this package issued deeply frozen; undefined for every other value. */
export type CatalogRetention = (value: object) => CatalogFootprint | undefined;
interface CopyBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly ancestors: Set<object>;
  readonly retained?: CatalogRetention | undefined;
  bytes: number;
  deepest: number;
  longestString: number;
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
  if (typeof value === "string") {
    const length = ENCODER.encode(value).length;
    requireCatalog(length <= budget.maxStringBytes, "input-bound");
    budget.longestString = Math.max(budget.longestString, length);
  }
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
  budget.deepest = Math.max(budget.deepest, depth);
  let result: CatalogJsonValue;
  if (typeof value !== "object" || value === null) {
    result = scalar(value, budget);
  } else {
    const footprint = budget.retained?.(value);
    result =
      footprint === undefined
        ? copyComposite(value, budget, depth)
        : retainValue(value, footprint, budget, depth);
  }
  return result;
}

function copyComposite(value: object, budget: CopyBudget, depth: number): CatalogJsonValue {
  requireCatalog(!budget.ancestors.has(value), "invalid-shape");
  budget.ancestors.add(value);
  const result = Array.isArray(value)
    ? copyArray(value, budget, depth)
    : copyObject(value, budget, depth);
  budget.ancestors.delete(value);
  return result;
}

// A deeply frozen value this package issued after validating it cannot have changed since, so
// copying it again only repeats that work. It is kept by identity and charged the footprint its
// own copy measured, so this copy's byte, depth and string bounds still apply in full.
function retainValue(
  value: object,
  footprint: CatalogFootprint,
  budget: CopyBudget,
  depth: number,
): CatalogJsonValue {
  const deepest = depth + footprint.depth - 1;
  requireCatalog(
    deepest <= budget.maxDepth && footprint.longestString <= budget.maxStringBytes,
    "input-bound",
  );
  budget.deepest = Math.max(budget.deepest, deepest);
  budget.longestString = Math.max(budget.longestString, footprint.longestString);
  budget.bytes += footprint.bytes;
  requireCatalog(budget.bytes <= budget.maxBytes, "input-bound");
  return value as CatalogJsonValue;
}

/**
 * The footprint a bounded copy of `value` charges, measured by that same copy. Only shape is
 * enforced here: a later copy that keeps the value applies its own bounds to this footprint.
 */
export function measureCatalogFootprint(value: unknown): CatalogFootprint {
  const budget: CopyBudget = {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxDepth: Number.MAX_SAFE_INTEGER,
    maxStringBytes: Number.MAX_SAFE_INTEGER,
    ancestors: new Set(),
    bytes: 0,
    deepest: 0,
    longestString: 0,
  };
  copyValue(value, budget, 1);
  return Object.freeze({
    bytes: budget.bytes,
    depth: budget.deepest,
    longestString: budget.longestString,
  });
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

/**
 * The same envelope copy, keeping each value `retained` vouches for by identity. Package-internal:
 * only this package's own issuers may vouch, so it is deliberately absent from the public index.
 */
export function copyCatalogEnvelopeRetaining(
  value: unknown,
  retained: CatalogRetention,
): CatalogJsonValue {
  return copyWithinBounds(
    value,
    TOOL_CATALOG_LIMITS.maxArgumentBytes,
    TOOL_CATALOG_LIMITS.maxSchemaDepth + 6,
    GENERIC_TOOL_ARGUMENT_LIMITS,
    retained,
  );
}

function copyWithinBounds(
  value: unknown,
  requestedBytes: number | undefined,
  maxDepth: number,
  limits: ToolArgumentLimits,
  retained?: CatalogRetention,
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
      {
        maxBytes,
        maxDepth,
        maxStringBytes,
        ancestors: new Set(),
        retained,
        bytes: 0,
        deepest: 0,
        longestString: 0,
      },
      1,
    );
  } catch (error) {
    if (error instanceof ToolCatalogError) throw error;
    throw new ToolCatalogError("invalid-shape");
  }
}

export function catalogObject(value: CatalogJsonValue | undefined): CatalogJsonObject {
  requireCatalog(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "invalid-shape",
  );
  return value as CatalogJsonObject;
}

export function exactCatalogKeys(value: CatalogJsonObject, keys: readonly string[]): void {
  requireCatalog(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    "invalid-shape",
  );
}

export function catalogString(value: CatalogJsonValue | undefined): string {
  requireCatalog(typeof value === "string" && value.length > 0, "invalid-shape");
  return value;
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
  requireCatalog(Array.isArray(value), "invalid-shape");
  return value as readonly CatalogJsonValue[];
}
