// Attack class: ORPHAN HANDLER — a profile offers a tool reference with no matching descriptor
// in the catalog, i.e. a would-be handler slot with nothing behind it. The compiler's profile
// assertion (packages/keiko-tool-catalog/src/catalog.ts assertProfiles) must reject the dangling
// reference rather than compiling a projection that offers a tool no descriptor backs.
import { composedProductionCatalog, rawCatalogValue } from "./_shared.mjs";

export const ATTACK_CLASS = "orphan-handler";
export const EXPECTED_REASON = "invalid-identity";

export function attempt(producer) {
  const catalog = composedProductionCatalog(producer);
  const raw = structuredClone(rawCatalogValue(catalog));
  const childProfile = raw.profiles.find((profile) => profile.profile.id === "child");
  childProfile.toolRefs.push({
    toolRef: { canonicalId: "keiko.child.workspace.orphan", contractVersion: 1 },
    alias: "orphan_tool",
  });
  producer.createToolCatalog(raw, { referenceTimeMs: 0 });
}
