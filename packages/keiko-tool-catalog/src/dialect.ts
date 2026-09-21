import {
  NATIVE_TOOL_CATALOG_RUNTIME,
  type CatalogJsonObject,
  type CatalogRuntimeRef,
  type CatalogVersionRef,
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

// The native ("keiko") adapter runtime identity every non-OpenCode dialect pins against. One value,
// owned by the contracts leaf and re-exported here for `legacy.ts` and `child.ts`, so no registration
// set can bind a hand-copied literal that drifts from `assertCatalogDialect` (b3-25). It names the
// native tool-calling contract, not the release: a version bump must not move catalog identity
// (#3565).
export { NATIVE_TOOL_CATALOG_RUNTIME };

export function assertCatalogDialect(dialect: CatalogVersionRef, runtime: CatalogRuntimeRef): void {
  requireCatalog(dialect.version === 1 && DIALECT_IDS.has(dialect.id), "unsupported-dialect");
  if (dialect.id === "managed-runtime-json-schema") {
    requireCatalog(
      runtime.id === "opencode" && runtime.version === "2.0.10",
      "unsupported-dialect",
    );
  } else {
    requireCatalog(
      runtime.id === NATIVE_TOOL_CATALOG_RUNTIME.id &&
        runtime.version === NATIVE_TOOL_CATALOG_RUNTIME.version,
      "unsupported-dialect",
    );
  }
}

function managedInputSchema(schema: CatalogJsonObject): CatalogJsonObject {
  if (schema.type === "object") {
    const properties = catalogObject(schema.properties);
    requireCatalog(
      catalogArray(schema.required).length === Object.keys(properties).length,
      "unrepresentable-projection",
    );
    // V2 supplies a closed boundary; accepting an open declaration would silently narrow it.
    requireCatalog(schema.additionalProperties === false, "unrepresentable-projection");
    return {
      ...schema,
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
