import { createInitialToolCatalog, compileToolProjection } from "@oscharko-dev/keiko-tool-catalog";
import type { GatewayToolCatalogAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";

export function gatewayCatalogAdvertisement(
  now: number,
  aliases?: readonly string[],
): GatewayToolCatalogAdvertisement {
  const catalog = createInitialToolCatalog();
  const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
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
