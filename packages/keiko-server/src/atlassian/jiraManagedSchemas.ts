import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export function text(maxLength: number): CatalogJsonObject {
  return { type: "string", maxLength };
}
/** A required-meaning value such as a key, name or identifier; native Jira rejects an empty one. */
export function identifier(maxLength: number): CatalogJsonObject {
  return { type: "string", minLength: 1, maxLength };
}
export function object(
  properties: CatalogJsonObject,
  required: readonly string[] = [],
): CatalogJsonObject {
  return { type: "object", required, additionalProperties: false, properties };
}
