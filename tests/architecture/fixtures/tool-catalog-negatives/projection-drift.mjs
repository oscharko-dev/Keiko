// Attack class: PROJECTION DRIFT — a manifest is built from a projection whose recorded
// `projectionDigest` no longer matches what recompiling the same catalog/profile produces. The
// manifest producer (packages/keiko-tool-catalog/src/projection.ts createCatalogManifest)
// recompiles and compares before trusting the caller-supplied projection, so a tampered digest
// must be rejected rather than published as a valid manifest.
import { composedProductionCatalog } from "./_shared.mjs";

export const ATTACK_CLASS = "projection-drift";
export const EXPECTED_REASON = "invalid-identity";

export function attempt(producer) {
  const catalog = composedProductionCatalog(producer);
  const projection = producer.compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  const tampered = { ...projection, projectionDigest: "0".repeat(64) };
  producer.createCatalogManifest(catalog, tampered);
}
