// Hostile-JSON narrowing shared by the Atlassian adapters: type predicates, so no caller needs
// `any` or a type assertion to read a provider or model value.

import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { isRecord } from "@oscharko-dev/keiko-contracts/runtime/coding-context";

/** The value as a plain JSON object, or undefined for anything else. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Whether a value is an array; its members stay unknown until each one is narrowed. */
export function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether a catalog JSON value is an object: not null and not an array. */
export function isCatalogJsonObject(
  value: CatalogJsonValue | undefined,
): value is CatalogJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a catalog JSON value is an array of catalog JSON values. */
export function isCatalogJsonArray(
  value: CatalogJsonValue | undefined,
): value is readonly CatalogJsonValue[] {
  return Array.isArray(value);
}
