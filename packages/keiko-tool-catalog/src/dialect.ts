import {
  NATIVE_TOOL_CATALOG_RUNTIME,
  type CatalogJsonObject,
  type CatalogRuntimeRef,
  type CatalogVersionRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { OPENCODE_CATALOG_RUNTIME } from "@oscharko-dev/keiko-contracts/runtime/opencode-runtime-pins";
import { deepFreeze, isDeepFrozen } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
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
      runtime.id === OPENCODE_CATALOG_RUNTIME.id &&
        runtime.version === OPENCODE_CATALOG_RUNTIME.version,
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
type ProjectionKind = "managed-input" | "compiled";

function compileProjection(schema: CatalogJsonObject, kind: ProjectionKind): CatalogJsonObject {
  const projected = compileCatalogSchema(schema);
  return kind === "managed-input" ? managedInputSchema(projected) : projected;
}

// A catalog's descriptors are deeply frozen at issue, so a projection of one of their schemas
// cannot change. Every catalog that offers the same descriptor reuses that projection instead of
// compiling the already compiled schema again: each Jira chat selection composes a new catalog.
const PROJECTIONS = new WeakMap<object, Partial<Record<ProjectionKind, CatalogJsonObject>>>();

export function projectCatalogSchema(
  schema: CatalogJsonObject,
  dialect: CatalogVersionRef,
  input: boolean,
): CatalogJsonObject {
  const kind: ProjectionKind =
    input && dialect.id === "managed-runtime-json-schema" ? "managed-input" : "compiled";
  if (!isDeepFrozen(schema)) return compileProjection(schema, kind);
  const known = PROJECTIONS.get(schema);
  const cached = known?.[kind];
  if (cached !== undefined) return cached;
  const projected = deepFreeze(compileProjection(schema, kind));
  PROJECTIONS.set(schema, { ...known, [kind]: projected });
  return projected;
}
