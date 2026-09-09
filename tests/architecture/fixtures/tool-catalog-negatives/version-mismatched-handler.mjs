// Attack class: VERSION-MISMATCHED HANDLER — a descriptor claims to be the SAME contract
// version as a previously published descriptor while changing the handler contract it
// declares (`handlerRequirement.contractVersion`). The compiler's version-progression check
// (packages/keiko-tool-catalog/src/descriptor.ts createToolDescriptor) requires the digest to
// stay identical when the contract version does not advance, so a same-version handler-contract
// change must be rejected rather than silently accepted as a compatible republish.
import { composedProductionCatalog, descriptorDeclaration } from "./_shared.mjs";

export const ATTACK_CLASS = "version-mismatched-handler";
export const EXPECTED_REASON = "incompatible-version";

export function attempt(producer) {
  const catalog = composedProductionCatalog(producer);
  const previous = producer.lookupCatalogTool(catalog, {
    canonicalId: "keiko.child.workspace.read",
    contractVersion: 1,
  });
  const declaration = descriptorDeclaration(previous);
  declaration.handlerRequirement = { ...declaration.handlerRequirement, contractVersion: 2 };
  producer.createToolDescriptor(declaration, previous);
}
