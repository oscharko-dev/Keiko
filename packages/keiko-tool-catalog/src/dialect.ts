import type {
  CatalogJsonObject,
  CatalogRuntimeRef,
  CatalogVersionRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { catalogArray, catalogObject } from "./json.js";
import { compileCatalogSchema } from "./schema.js";
import { requireCatalog } from "./errors.js";

export const CATALOG_DIALECTS = Object.freeze([
  "gateway-json-schema",
  "managed-runtime-json-schema",
  "editor-json-schema",
  "child-agent-json-schema",
  "legacy-json-schema",
] as const);
const DIALECT_IDS: ReadonlySet<string> = new Set(CATALOG_DIALECTS);

export function assertCatalogDialect(dialect: CatalogVersionRef, runtime: CatalogRuntimeRef): void {
  requireCatalog(dialect.version === 1 && DIALECT_IDS.has(dialect.id), "unsupported-dialect");
  if (dialect.id === "managed-runtime-json-schema") {
    requireCatalog(
      runtime.id === "opencode" && runtime.version === "1.17.17",
      "unsupported-dialect",
    );
  } else {
    requireCatalog(runtime.id === "keiko" && runtime.version === "0.3.17", "unsupported-dialect");
  }
}

function managedInputSchema(schema: CatalogJsonObject): CatalogJsonObject {
  if (schema.type === "object") {
    const properties = catalogObject(schema.properties);
    requireCatalog(
      catalogArray(schema.required).length === Object.keys(properties).length,
      "unrepresentable-projection",
    );
    // The pinned runtime strips this keyword. Only its default-true semantics survive.
    requireCatalog(schema.additionalProperties === true, "unrepresentable-projection");
    const projected = { ...schema };
    delete projected.additionalProperties;
    return {
      ...projected,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          managedInputSchema(catalogObject(value)),
        ]),
      ),
    };
  }
  if (schema.type === "array")
    return { ...schema, items: managedInputSchema(catalogObject(schema.items)) };
  return schema;
}

/** The five adapters share the closed core; OpenCode's required-field transform must be lossless. */
export function projectCatalogSchema(
  schema: CatalogJsonObject,
  dialect: CatalogVersionRef,
  input: boolean,
): CatalogJsonObject {
  const projected = compileCatalogSchema(schema);
  if (input && dialect.id === "managed-runtime-json-schema") return managedInputSchema(projected);
  return projected;
}
