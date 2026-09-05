import type {
  CatalogCompatibility,
  CatalogDigest,
  CatalogProfile,
  CatalogProfileDeclaration,
  ToolDescriptor,
  ToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { catalogArray, catalogObject, copyCatalogJson, exactCatalogKeys } from "./json.js";
import { catalogDigest, semanticDigest, toolRefKey } from "./identity.js";
import { createToolDescriptor, verifyToolDescriptor } from "./descriptor.js";
import { createCatalogProfileDeclaration, stampCatalogProfile } from "./profile.js";
import { assertIdentityCompatibility, compatibilityFrom } from "./compatibility.js";
import { assertCatalogDialect } from "./dialect.js";
import { requireCatalog } from "./errors.js";

export interface ToolCatalog {
  readonly catalogRevision: CatalogDigest;
  readonly descriptors: readonly ToolDescriptor[];
  readonly profiles: readonly CatalogProfile[];
  readonly compatibility: readonly CatalogCompatibility[];
}
export interface CatalogCompilationContext {
  readonly referenceTimeMs: number;
  readonly previous?: ToolCatalog | undefined;
}

function descriptorsFrom(
  value: unknown,
  previous: readonly ToolDescriptor[],
): readonly ToolDescriptor[] {
  const descriptors = catalogArray(copyCatalogJson(value)).map((entry): ToolDescriptor => {
    const object = catalogObject(entry);
    const descriptor = Object.hasOwn(object, "descriptorDigest")
      ? verifyToolDescriptor(object)
      : createToolDescriptor(object);
    const prior = previous.find(
      (item) => item.toolRef.canonicalId === descriptor.toolRef.canonicalId,
    );
    if (prior !== undefined) {
      const { descriptorDigest, ...declaration } = descriptor;
      requireCatalog(
        createToolDescriptor(declaration, verifyToolDescriptor(prior)).descriptorDigest ===
          descriptorDigest,
        "incompatible-version",
      );
    }
    return descriptor;
  });
  requireCatalog(
    new Set(descriptors.map((item) => item.toolRef.canonicalId)).size === descriptors.length,
    "duplicate-identity",
  );
  return descriptors.sort((left, right) =>
    compareStrings(toolRefKey(left.toolRef), toolRefKey(right.toolRef)),
  );
}

export function lookupCatalogTool(catalog: ToolCatalog, ref: ToolRef): ToolDescriptor | undefined {
  return catalog.descriptors.find(
    (descriptor) => toolRefKey(descriptor.toolRef) === toolRefKey(ref),
  );
}

function assertCompatibilityEntries(
  entries: readonly CatalogCompatibility[],
  descriptors: readonly ToolDescriptor[],
  context: CatalogCompilationContext,
): void {
  const identities = entries.map((entry) => canonicalise(entry));
  requireCatalog(new Set(identities).size === entries.length, "duplicate-identity");
  for (const entry of entries) {
    const from = [...(context.previous?.descriptors ?? []), ...descriptors].find(
      (item) =>
        toolRefKey(item.toolRef) === toolRefKey(entry.from.toolRef) &&
        item.descriptorDigest === entry.from.descriptorDigest,
    );
    const to = descriptors.find(
      (item) => toolRefKey(item.toolRef) === toolRefKey(entry.to.toolRef),
    );
    requireCatalog(from !== undefined && to !== undefined, "invalid-compatibility");
    assertIdentityCompatibility(entry, from, to, context.referenceTimeMs);
  }
}

function assertProfiles(catalog: ToolCatalog): void {
  const profiles = catalog.profiles.map(
    (entry) => `${entry.profile.id}@${String(entry.profile.version)}`,
  );
  requireCatalog(new Set(profiles).size === profiles.length, "duplicate-identity");
  const declaredCompatibility = new Set(catalog.compatibility.map((entry) => canonicalise(entry)));
  for (const profile of catalog.profiles) {
    assertCatalogDialect(profile.adapterDialect, profile.adapterRuntime);
    requireCatalog(
      profile.toolRefs.every((entry) => lookupCatalogTool(catalog, entry.toolRef) !== undefined),
      "invalid-identity",
    );
    requireCatalog(
      profile.compatibility.every(
        (entry) =>
          declaredCompatibility.has(canonicalise(entry)) &&
          canonicalise(entry.profile) === canonicalise(profile.profile) &&
          canonicalise(entry.adapter) === canonicalise(profile.adapterRuntime),
      ),
      "invalid-compatibility",
    );
  }
}

function snapshot(
  descriptors: readonly ToolDescriptor[],
  declarations: readonly CatalogProfileDeclaration[],
  compatibility: readonly CatalogCompatibility[],
): ToolCatalog {
  const catalogRevision = semanticDigest("keiko.tool-catalog.v1", {
    sortedDescriptorDigests: descriptors
      .map((entry) => entry.descriptorDigest)
      .sort(compareStrings),
    profiles: declarations,
    compatibility,
  });
  const catalog = {
    catalogRevision,
    descriptors,
    profiles: declarations.map((declaration) => stampCatalogProfile(declaration, catalogRevision)),
    compatibility,
  };
  assertProfiles(catalog);
  return deepFreeze(catalog);
}

function assertProfileProgression(
  declarations: readonly CatalogProfileDeclaration[],
  previous: readonly CatalogProfile[],
): void {
  for (const declaration of declarations) {
    const versions = previous
      .filter((entry) => entry.profile.id === declaration.profile.id)
      .map((entry) => entry.profile.version);
    // Retaining an explicitly published historical profile is not latest rebinding.
    if (versions.includes(declaration.profile.version)) continue;
    requireCatalog(declaration.profile.version >= Math.max(0, ...versions), "incompatible-version");
  }
}

/** Verify content identity; time-dependent compatibility eligibility remains the producer's check. */
export function verifyToolCatalogSnapshot(value: unknown): ToolCatalog {
  const object = catalogObject(copyCatalogJson(value));
  exactCatalogKeys(object, ["catalogRevision", "descriptors", "profiles", "compatibility"]);
  const revision = catalogDigest(object.catalogRevision);
  const descriptors = descriptorsFrom(object.descriptors, []);
  const declarations = catalogArray(object.profiles)
    .map((entry) => {
      const { catalogRevision, ...declaration } = catalogObject(entry);
      requireCatalog(catalogRevision === revision, "invalid-identity");
      return createCatalogProfileDeclaration(declaration);
    })
    .sort((left, right) => compareStrings(canonicalise(left.profile), canonicalise(right.profile)));
  const compatibility = catalogArray(object.compatibility)
    .map(compatibilityFrom)
    .sort((left, right) => compareStrings(canonicalise(left), canonicalise(right)));
  const verified = snapshot(descriptors, declarations, compatibility);
  requireCatalog(verified.catalogRevision === revision, "invalid-identity");
  return verified;
}

/** Pure snapshot construction: callers supply the comparison snapshot and compatibility clock. */
export function createToolCatalog(value: unknown, context: CatalogCompilationContext): ToolCatalog {
  const object = catalogObject(copyCatalogJson(value));
  exactCatalogKeys(object, ["descriptors", "profiles", "compatibility"]);
  const previous =
    context.previous === undefined ? undefined : verifyToolCatalogSnapshot(context.previous);
  const descriptors = descriptorsFrom(object.descriptors, previous?.descriptors ?? []);
  const declarations = catalogArray(object.profiles)
    .map(createCatalogProfileDeclaration)
    .sort((left, right) => compareStrings(canonicalise(left.profile), canonicalise(right.profile)));
  const compatibility = catalogArray(object.compatibility)
    .map(compatibilityFrom)
    .sort((left, right) => compareStrings(canonicalise(left), canonicalise(right)));
  assertCompatibilityEntries(compatibility, descriptors, { ...context, previous });
  assertProfileProgression(declarations, previous?.profiles ?? []);
  return snapshot(descriptors, declarations, compatibility);
}
