// Shared builders for the #3415 catalog-semantic negative-fixture matrix.
//
// Every fixture in this directory derives its base data from the REAL production producer
// (@oscharko-dev/keiko-tool-catalog's built dist plus the real `legacyNativeRegistrationSet` /
// `childRegistrationSet` registrations) rather than restating a hand-typed catalog shape —
// AGENTS.md §7's fixture rule: a fixture that recomputes what the producer owns cannot detect the
// producer's formula moving out from under it. Each fixture then applies exactly ONE minimal,
// named mutation and asserts the SAME producer rejects it. Nothing here is reachable from
// production code: this directory is scanned by no build, only imported by
// scripts/__tests__/tool-catalog-conformance.test.mjs and scripts/arch-check-negative.mjs.
//
// `expectRejection` normalizes both shapes a fixture can prove: a producer function that THROWS
// a `ToolCatalogError` (most classes), or a pure comparator that returns `true` when it detects
// drift (the legacy-table-reintroduction class, which is a data comparison, not a throw).

/** Composes the two real, shipped registration sets so mutations have two independent tools to work with. */
export function composedProductionCatalog(producer) {
  return producer.createKeikoToolCatalog([
    producer.legacyNativeRegistrationSet(),
    producer.childRegistrationSet(),
  ]);
}

/** Strips `catalogRevision` so a mutated profile list can be re-fed to `createToolCatalog`. */
export function rawCatalogValue(catalog) {
  return {
    descriptors: catalog.descriptors,
    profiles: catalog.profiles.map(
      ({ catalogRevision: _catalogRevision, ...declaration }) => declaration,
    ),
    compatibility: catalog.compatibility,
  };
}

/** Strips `descriptorDigest` so a mutated descriptor can be re-fed to `createToolDescriptor`. */
export function descriptorDeclaration(descriptor) {
  const { descriptorDigest: _descriptorDigest, ...declaration } = descriptor;
  return structuredClone(declaration);
}

/**
 * Runs `attempt()` and normalizes the outcome to `{ rejected, reason }`. A throw is rejection by
 * exception (the common case: every pure-compiler invariant in packages/keiko-tool-catalog uses
 * `requireCatalog`, which throws `ToolCatalogError`). Returning the literal object
 * `{ rejectedByComparison: true, reason }` is rejection by value (the legacy-table-reintroduction
 * class, which is a boolean drift comparison, not a throw).
 */
export function expectRejection(attempt) {
  try {
    const result = attempt();
    if (result !== null && typeof result === "object" && result.rejectedByComparison === true)
      return { rejected: true, reason: result.reason };
    return { rejected: false, reason: undefined };
  } catch (error) {
    const reason =
      error !== null && typeof error === "object" && "reason" in error
        ? String(error.reason)
        : undefined;
    return { rejected: true, reason };
  }
}
