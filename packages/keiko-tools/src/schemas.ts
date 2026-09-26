// Finite legacy-native transport materialization. Canonical descriptors own every schema.
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import {
  compileToolProjection,
  computeHandlerSetDigest,
  createInitialToolCatalog,
  gatewayToolDefinitions,
} from "@oscharko-dev/keiko-tool-catalog";

const CATALOG = createInitialToolCatalog();
const PROFILE = { id: "legacy-native", version: 1 } as const;
const PROJECTION = compileToolProjection(CATALOG, PROFILE);

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = gatewayToolDefinitions(CATALOG, PROFILE);

/** Canonical dry-run projection with an intentionally empty productive handler set. */
export const UNAVAILABLE_TOOL_CATALOG_BINDING = Object.freeze({
  catalogRevision: CATALOG.catalogRevision,
  profile: PROJECTION.profile,
  projectionDigest: PROJECTION.projectionDigest,
  handlerSetDigest: computeHandlerSetDigest(PROJECTION.projectionDigest, []),
});
