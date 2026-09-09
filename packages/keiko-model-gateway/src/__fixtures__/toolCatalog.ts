import {
  createInitialToolCatalog,
  createKeikoToolCatalog,
  compileToolProjection,
  opencodeRegistrationSet,
  type ToolCatalog,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogVersionRef,
  CompiledToolProjection,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { GatewayToolCatalogAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";

function boundAdvertisement(
  catalog: ToolCatalog,
  projection: CompiledToolProjection,
  now: number,
  aliases?: readonly string[],
): GatewayToolCatalogAdvertisement {
  return {
    kind: "bound",
    catalog,
    projection,
    offered: {
      binding: {
        catalogRevision: catalog.catalogRevision,
        profile: projection.profile,
        projectionDigest: projection.projectionDigest,
        handlerSetDigest: projection.projectionDigest,
        readiness: "ready",
      },
      offerId: "offer-1",
      toolRefs: projection.tools
        .filter((tool) => aliases === undefined || aliases.includes(tool.alias))
        .map((tool) => tool.toolRef),
      expiresAt: new Date(now + 30_000).toISOString(),
    },
  };
}

export function gatewayCatalogAdvertisement(
  now: number,
  aliases?: readonly string[],
): GatewayToolCatalogAdvertisement {
  const catalog = createInitialToolCatalog();
  const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  return boundAdvertisement(catalog, projection, now, aliases);
}

const OPENCODE_PROFILE: CatalogVersionRef = { id: "opencode", version: 1 };

/**
 * A "bound" advertisement for the real `opencode` profile (#3414 follow-up): its projection
 * carries the two native extensions (`question`, `todowrite`) alongside the seven catalog tools,
 * derived from the same producer `opencodeRegistrationSet` that
 * packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts composes into its live gateway
 * advertisement (AGENTS.md §7: a fixture derives from the production entry point, never restates
 * it).
 */
export function openCodeGatewayCatalogAdvertisement(now: number): GatewayToolCatalogAdvertisement {
  const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
  const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
  return boundAdvertisement(catalog, projection, now);
}
