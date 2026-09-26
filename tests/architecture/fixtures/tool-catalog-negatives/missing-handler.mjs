// Attack class: MISSING HANDLER — a tool descriptor declared without a `handlerRequirement`,
// the field a bound handler is required to name. The compiler's own declaration-key contract
// (packages/keiko-tool-catalog/src/descriptor.ts DECLARATION_KEYS) must reject it outright
// rather than silently defaulting to "no handler bound".
import { composedProductionCatalog, descriptorDeclaration } from "./_shared.mjs";

export const ATTACK_CLASS = "missing-handler";
export const EXPECTED_REASON = "invalid-shape";

export function attempt(producer) {
  const catalog = composedProductionCatalog(producer);
  const descriptor = producer.lookupCatalogTool(catalog, {
    canonicalId: "keiko.child.workspace.read",
    contractVersion: 1,
  });
  const declaration = descriptorDeclaration(descriptor);
  delete declaration.handlerRequirement;
  producer.createToolDescriptor(declaration);
}
