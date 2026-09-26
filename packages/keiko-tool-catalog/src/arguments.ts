import type {
  CatalogJsonValue,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { verifyToolDescriptor } from "./descriptor.js";
import { ToolCatalogError } from "./errors.js";
import { copyCatalogJson } from "./json.js";
import { describeCatalogSchemaMismatch } from "./schema.js";

/** Validate and capture arguments before any asynchronous runtime admission or handler work. */
export function validateToolArguments(
  value: unknown,
  descriptor: ToolDescriptor,
): CatalogJsonValue {
  const verified = verifyToolDescriptor(descriptor);
  const captured = copyCatalogJson(value, verified.bounds.maxArgumentBytes);
  // The mismatch account rides on the error so the rejecting layer can name the declared property
  // that was missing or invalid -- in its log and in the model's one correction -- without quoting
  // the arguments.
  const mismatch = describeCatalogSchemaMismatch(verified.inputSchema, captured);
  if (mismatch !== undefined) throw new ToolCatalogError("invalid-shape", mismatch);
  return deepFreeze(captured);
}
