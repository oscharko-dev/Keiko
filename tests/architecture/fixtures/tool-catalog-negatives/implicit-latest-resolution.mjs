// Attack class: IMPLICIT-LATEST RESOLUTION — an invocation request names a tool by canonical
// identity while either omitting `contractVersion` entirely, or supplying the literal string
// `"latest"` in its place, attempting to have the producer resolve "whichever version is current"
// rather than pinning one exactly. `toolRefFrom` (packages/keiko-tool-catalog/src/identity.ts),
// reached from the real call-time wire boundary `createToolInvocationNormalizer(...).normalize`,
// requires BOTH `canonicalId` and `contractVersion` via `exactCatalogKeys`, and `contractVersion`
// must be a safe positive integer (`catalogPositive`) — so this class is structurally impossible
// today. #3415 AC3 asks for a named proof of that against the real producer, not just the claim.
import { composedProductionCatalog } from "./_shared.mjs";

export const ATTACK_CLASS = "implicit-latest-resolution";
export const EXPECTED_REASON = "invalid-shape";

function realBinding(producer) {
  const catalog = composedProductionCatalog(producer);
  const projection = producer.compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  return {
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
      offerId: "implicit-latest-resolution-offer",
      toolRefs: projection.tools.map((tool) => tool.toolRef),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  };
}

function attemptWithToolRef(producer, toolRef) {
  const binding = realBinding(producer);
  const normalizer = producer.createToolInvocationNormalizer(binding);
  normalizer.normalize(
    {
      kind: "bound",
      toolRef,
      projectionDigest: binding.projection.projectionDigest,
      offerId: binding.offered.offerId,
      arguments: {},
    },
    Date.now(),
  );
}

export function attemptOmittedContractVersion(producer) {
  const canonicalId = realBinding(producer).projection.tools[0].toolRef.canonicalId;
  attemptWithToolRef(producer, { canonicalId });
}

export function attemptLatestLiteral(producer) {
  const canonicalId = realBinding(producer).projection.tools[0].toolRef.canonicalId;
  attemptWithToolRef(producer, { canonicalId, contractVersion: "latest" });
}
