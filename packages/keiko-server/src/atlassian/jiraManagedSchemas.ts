import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export function text(maxLength: number): CatalogJsonObject {
  return { type: "string", maxLength };
}
export function object(
  properties: CatalogJsonObject,
  required: readonly string[] = [],
): CatalogJsonObject {
  return { type: "object", required, additionalProperties: false, properties };
}
