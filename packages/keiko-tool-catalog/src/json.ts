import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { requireCatalog, ToolCatalogError } from "./errors.js";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

const ENCODER = new TextEncoder();
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
interface CopyBudget {
  readonly maxBytes: number;
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
    requireCatalog(
      ENCODER.encode(value).length <= TOOL_CATALOG_LIMITS.maxStringBytes,
      "input-bound",
    );
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

function copyValue(value: unknown, budget: CopyBudget, depth: number): CatalogJsonValue {
  requireCatalog(depth <= TOOL_CATALOG_LIMITS.maxSchemaDepth, "input-bound");
  if (typeof value !== "object" || value === null) return scalar(value, budget);
  requireCatalog(!budget.ancestors.has(value), "invalid-shape");
  budget.ancestors.add(value);
  const copied = Array.isArray(value)
    ? copyArray(value, budget, depth)
    : copyObject(value, budget, depth);
  budget.ancestors.delete(value);
  return copied;
}

/** Validate and detach before canonicalization, freezing, hashing, or schema interpretation. */
export function copyCatalogJson(
  value: unknown,
  maxBytes: number = TOOL_CATALOG_LIMITS.maxArgumentBytes,
): CatalogJsonValue {
  requireCatalog(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= TOOL_CATALOG_LIMITS.maxResultBytes,
    "input-bound",
  );
  try {
    return copyValue(value, { maxBytes, ancestors: new Set(), bytes: 0 }, 1);
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
