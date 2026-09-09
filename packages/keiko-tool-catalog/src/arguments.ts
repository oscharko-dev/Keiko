import type {
  CatalogJsonValue,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { verifyToolDescriptor } from "./descriptor.js";
import { requireCatalog } from "./errors.js";
import { copyCatalogJson } from "./json.js";
import { matchesCatalogSchema } from "./schema.js";

/** Validate and capture arguments before any asynchronous runtime admission or handler work. */
export function validateToolArguments(
  value: unknown,
  descriptor: ToolDescriptor,
): CatalogJsonValue {
  const verified = verifyToolDescriptor(descriptor);
  const captured = copyCatalogJson(value, verified.bounds.maxArgumentBytes);
  requireCatalog(matchesCatalogSchema(verified.inputSchema, captured), "invalid-shape");
  return deepFreeze(captured);
}
