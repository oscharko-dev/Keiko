// Attack class: ALIAS COLLISION OR CONFUSABLE — two sub-cases of the same class:
//   (a) collision: two different tools in one profile registered under the identical alias, so
//       a caller's tool-name lookup would be ambiguous.
//   (b) confusable: an alias using characters outside the closed charset
//       (packages/keiko-tool-catalog/src/identity.ts catalogAlias, `^[a-z][a-z0-9_]{0,63}$`),
//       e.g. an uppercase variant that could be visually confused with the real, lowercase alias.
// Both must be rejected by the compiler: collisions by the profile's alias-uniqueness assertion
// (packages/keiko-tool-catalog/src/profile.ts profileTools), confusables by the alias charset
// itself refusing anything the canonical lowercase form does not already permit.
import { composedProductionCatalog, rawCatalogValue } from "./_shared.mjs";

export const ATTACK_CLASS = "alias-collision-or-confusable";
export const EXPECTED_REASONS = Object.freeze({
  collision: "duplicate-identity",
  confusable: "invalid-identity",
});

export function attemptCollision(producer) {
  const catalog = composedProductionCatalog(producer);
  const raw = structuredClone(rawCatalogValue(catalog));
  const legacyProfile = raw.profiles.find((profile) => profile.profile.id === "legacy-native");
  legacyProfile.toolRefs[1].alias = legacyProfile.toolRefs[0].alias;
  producer.createToolCatalog(raw, { referenceTimeMs: 0 });
}

export function attemptConfusable(producer) {
  const catalog = composedProductionCatalog(producer);
  const raw = structuredClone(rawCatalogValue(catalog));
  const legacyProfile = raw.profiles.find((profile) => profile.profile.id === "legacy-native");
  legacyProfile.toolRefs[0].alias = legacyProfile.toolRefs[0].alias.toUpperCase();
  producer.createToolCatalog(raw, { referenceTimeMs: 0 });
}
