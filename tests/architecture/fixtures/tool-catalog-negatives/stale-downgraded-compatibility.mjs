// Attack class: STALE OR DOWNGRADED COMPATIBILITY — two sub-cases:
//   (a) stale: a compatibility entry whose `expiresAt` has already passed the reference clock.
//       packages/keiko-tool-catalog/src/compatibility.ts assertCompatibilityTime must reject it
//       rather than treating an expired bridge as still usable.
//   (b) downgraded: a compatibility entry whose "to" descriptor widens (weakens) a result bound
//       relative to "from" while every other semantic stays identical.
//       packages/keiko-tool-catalog/src/compatibility.ts assertIdentityCompatibility requires
//       every bound to stay at or under the "from" descriptor's bound, so a widened
//       (downgraded-safety) bound must be rejected even though the transform is otherwise a
//       byte-identical identity transform.
import { composedProductionCatalog, descriptorDeclaration } from "./_shared.mjs";

export const ATTACK_CLASS = "stale-downgraded-compatibility";
export const EXPECTED_REASONS = Object.freeze({
  stale: "expired-compatibility",
  downgraded: "invalid-compatibility",
});
const ADAPTER = Object.freeze({ id: "keiko", version: "0.3.17" });
const PROFILE_REF = Object.freeze({ id: "legacy-native", version: 1 });

export function attemptStale(producer) {
  const catalog = composedProductionCatalog(producer);
  const descriptor = producer.lookupCatalogTool(catalog, {
    canonicalId: "keiko.file.read",
    contractVersion: 1,
  });
  const entry = {
    from: { toolRef: descriptor.toolRef, descriptorDigest: descriptor.descriptorDigest },
    to: { toolRef: descriptor.toolRef, descriptorDigest: descriptor.descriptorDigest },
    profile: PROFILE_REF,
    adapter: ADAPTER,
    transformId: "identity-v1",
    ownerIssue: 3415,
    expiresAt: "2020-01-01T00:00:00.000Z",
    removalIssue: 3415,
  };
  producer.assertCompatibilityTime(entry, Date.now());
}

export function attemptDowngraded(producer) {
  const catalog = composedProductionCatalog(producer);
  const from = producer.lookupCatalogTool(catalog, {
    canonicalId: "keiko.file.read",
    contractVersion: 1,
  });
  const toDeclaration = descriptorDeclaration(from);
  toDeclaration.toolRef = { ...toDeclaration.toolRef, contractVersion: 2 };
  // Widen (downgrade) a single bound; transformSemantics deliberately excludes bounds, so this
  // is otherwise a byte-identical transform and only the bounds check can catch it.
  toDeclaration.bounds = {
    ...toDeclaration.bounds,
    maxResultCount: toDeclaration.bounds.maxResultCount + 1,
  };
  const to = producer.createToolDescriptor(toDeclaration, from);
  const entry = {
    from: { toolRef: from.toolRef, descriptorDigest: from.descriptorDigest },
    to: { toolRef: to.toolRef, descriptorDigest: to.descriptorDigest },
    profile: PROFILE_REF,
    adapter: ADAPTER,
    transformId: "identity-v1",
    ownerIssue: 3415,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    removalIssue: 3415,
  };
  producer.assertIdentityCompatibility(entry, from, to, Date.now());
}
