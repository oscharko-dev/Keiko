// Attack class: POLICY/EFFECT MISMATCH — a descriptor's action mapping claims an effect
// (`workspace-write`) beyond what the tool's own top-level `effects` list — the set the policy
// layer authorizes against — declares. The compiler's action-mapping assertion
// (packages/keiko-tool-catalog/src/descriptor.ts actionMappings) requires the mapped-effect set
// to equal the declared-effect set exactly, so a mapping that reaches for an undeclared,
// unauthorized effect must be rejected.
import { composedProductionCatalog, descriptorDeclaration } from "./_shared.mjs";

export const ATTACK_CLASS = "policy-effect-mismatch";
export const EXPECTED_REASON = "ambiguous-effects";

export function attempt(producer) {
  const catalog = composedProductionCatalog(producer);
  const descriptor = producer.lookupCatalogTool(catalog, {
    canonicalId: "keiko.file.read",
    contractVersion: 1,
  });
  const declaration = descriptorDeclaration(descriptor);
  declaration.actionMapping = [
    {
      action: declaration.actionMapping[0].action,
      effects: [...declaration.effects, "workspace-write"],
    },
  ];
  producer.createToolDescriptor(declaration);
}
