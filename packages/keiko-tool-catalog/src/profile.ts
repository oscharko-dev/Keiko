import type {
  CatalogDigest,
  CatalogJsonValue,
  CatalogNativeExtension,
  CatalogProfile,
  CatalogProfileDeclaration,
  CatalogProfileToolRef,
  CatalogVersionRef,
  CatalogRuntimeRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { catalogArray, catalogObject, copyCatalogJson, exactCatalogKeys } from "./json.js";
import {
  catalogAlias,
  runtimeRefFrom,
  toolRefFrom,
  toolRefKey,
  versionRefFrom,
} from "./identity.js";
import { compatibilityFrom } from "./compatibility.js";
import { requireCatalog } from "./errors.js";

function profileTools(value: CatalogJsonValue | undefined): readonly CatalogProfileToolRef[] {
  const refs = catalogArray(value).map((entry): CatalogProfileToolRef => {
    const object = catalogObject(entry);
    exactCatalogKeys(object, ["toolRef", "alias"]);
    return { toolRef: toolRefFrom(object.toolRef), alias: catalogAlias(object.alias) };
  });
  requireCatalog(
    new Set(refs.map((entry) => entry.toolRef.canonicalId)).size === refs.length,
    "duplicate-identity",
  );
  requireCatalog(
    new Set(refs.map((entry) => entry.alias)).size === refs.length,
    "duplicate-identity",
  );
  return refs.sort((left, right) =>
    compareStrings(toolRefKey(left.toolRef), toolRefKey(right.toolRef)),
  );
}

function extensions(value: CatalogJsonValue | undefined): readonly CatalogNativeExtension[] {
  const entries = catalogArray(value).map((entry): CatalogNativeExtension => {
    const object = catalogObject(entry);
    exactCatalogKeys(object, ["alias", "contractVersion"]);
    requireCatalog(
      (object.alias === "question" || object.alias === "execute") && object.contractVersion === 1,
      "invalid-identity",
    );
    return { alias: object.alias, contractVersion: 1 };
  });
  requireCatalog(
    new Set(entries.map((entry) => entry.alias)).size === entries.length,
    "duplicate-identity",
  );
  return entries.sort((left, right) => compareStrings(left.alias, right.alias));
}

function qualifyCodeModeExtensions(
  profile: CatalogVersionRef,
  runtime: CatalogRuntimeRef,
  extensions: readonly CatalogNativeExtension[],
): void {
  const hasExecute = extensions.some((extension) => extension.alias === "execute");
  if (profile.id !== "opencode-code-mode" && !hasExecute) return;
  requireCatalog(
    hasExecute &&
      profile.id === "opencode-code-mode" &&
      profile.version === 1 &&
      runtime.id === "opencode" &&
      runtime.version === "2.0.10" &&
      extensions.some((extension) => extension.alias === "question"),
    "unrepresentable-projection",
  );
}

export function createCatalogProfileDeclaration(value: unknown): CatalogProfileDeclaration {
  const object = catalogObject(copyCatalogJson(value));
  exactCatalogKeys(object, [
    "profile",
    "toolRefs",
    "nativeExtensions",
    "adapterDialect",
    "adapterRuntime",
    "compatibility",
  ]);
  const toolRefs = profileTools(object.toolRefs);
  const nativeExtensions = extensions(object.nativeExtensions);
  const adapterRuntime = runtimeRefFrom(object.adapterRuntime);
  const profile = versionRefFrom(object.profile);
  qualifyCodeModeExtensions(profile, adapterRuntime, nativeExtensions);
  requireCatalog(
    nativeExtensions.length === 0 || adapterRuntime.id === "opencode",
    "unrepresentable-projection",
  );
  const aliases = new Set(toolRefs.map((entry) => entry.alias));
  requireCatalog(
    nativeExtensions.every((entry) => !aliases.has(entry.alias)),
    "duplicate-identity",
  );
  const compatibility = catalogArray(object.compatibility).map(compatibilityFrom);
  const identities = compatibility.map((entry) => canonicalise(entry));
  requireCatalog(new Set(identities).size === compatibility.length, "duplicate-identity");
  compatibility.sort((left, right) => compareStrings(canonicalise(left), canonicalise(right)));
  return deepFreeze({
    profile,
    toolRefs,
    nativeExtensions,
    adapterDialect: versionRefFrom(object.adapterDialect),
    adapterRuntime,
    compatibility,
  });
}

export function stampCatalogProfile(
  declaration: CatalogProfileDeclaration,
  catalogRevision: CatalogDigest,
): CatalogProfile {
  return deepFreeze({ ...declaration, catalogRevision });
}
