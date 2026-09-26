// Attack class: DUPLICATE HANDLER — the same tool identity appears twice in one catalog
// snapshot, which would bind the same handler slot twice. The compiler's descriptor-set
// assertion (packages/keiko-tool-catalog/src/catalog.ts descriptorsFrom) must reject the
// duplicate outright.
import { composedProductionCatalog, rawCatalogValue } from "./_shared.mjs";

export const ATTACK_CLASS = "duplicate-handler";
export const EXPECTED_REASON = "duplicate-identity";

export function attempt(producer) {
  const catalog = composedProductionCatalog(producer);
  const raw = structuredClone(rawCatalogValue(catalog));
  raw.descriptors.push(structuredClone(raw.descriptors[0]));
  producer.createToolCatalog(raw, { referenceTimeMs: 0 });
}
