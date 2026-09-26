// Attack class: LEGACY-TABLE REINTRODUCTION — the legacy gateway tool table
// (packages/keiko-tools/src/schemas.js TOOL_DEFINITIONS, the pre-catalog "second registry" this
// epic is retiring) silently diverges from the catalog's own compiled projection of the same
// profile — e.g. a future edit reintroduces or hand-tweaks an entry there instead of going
// through the catalog. `legacyProjectionDiffers` (scripts/check-tool-catalog-conformance.mjs) is
// the exact comparator `checkToolCatalogConformance` runs on every PR; this fixture proves it
// actually detects drift by mutating a copy of the REAL legacy table by one field and asserting
// the comparator flags it, using `rejectedByComparison` (see `_shared.mjs`) since this class is a
// value comparison, not a throw.
import { composedProductionCatalog } from "./_shared.mjs";

export const ATTACK_CLASS = "legacy-table-reintroduction";
export const EXPECTED_REASON = "legacy-projection-drift";

export async function attempt(producer, root, legacyProjectionDiffers) {
  const legacy = await import(new URL(`file://${root}/packages/keiko-tools/dist/schemas.js`).href);
  const catalog = composedProductionCatalog(producer);
  const definitions = producer.gatewayToolDefinitions(catalog, { id: "legacy-native", version: 1 });
  const reintroduced = legacy.TOOL_DEFINITIONS.map((tool, index) =>
    index === 0 ? { ...tool, description: `${tool.description} (reintroduced)` } : tool,
  );
  const detected = legacyProjectionDiffers(definitions, reintroduced);
  return { rejectedByComparison: detected, reason: EXPECTED_REASON };
}
