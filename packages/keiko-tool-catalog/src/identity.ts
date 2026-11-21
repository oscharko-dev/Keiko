import type {
  CanonicalToolId,
  CatalogDigest,
  CatalogJsonObject,
  CatalogJsonValue,
  CatalogRuntimeRef,
  CatalogVersionRef,
  ToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { validTargetVersion } from "@oscharko-dev/keiko-contracts/runtime/update-session";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  catalogObject,
  catalogPositive,
  catalogString,
  copyCatalogJson,
  copyCatalogEnvelope,
  exactCatalogKeys,
} from "./json.js";
import { requireCatalog } from "./errors.js";

// The brands are erased at runtime; each pattern is the whole definition of its brand.
function isCanonicalToolId(value: string): value is CanonicalToolId {
  return /^keiko\.[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/u.test(value);
}

function isCatalogDigest(value: string): value is CatalogDigest {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function toolRefFrom(value: CatalogJsonValue | undefined): ToolRef {
  const object = catalogObject(value);
  exactCatalogKeys(object, ["canonicalId", "contractVersion"]);
  const canonicalId = catalogString(object.canonicalId);
  requireCatalog(isCanonicalToolId(canonicalId), "invalid-identity");
  return { canonicalId, contractVersion: catalogPositive(object.contractVersion) };
}

export function createToolRef(canonicalId: string, contractVersion: number): ToolRef {
  return deepFreeze(toolRefFrom(copyCatalogJson({ canonicalId, contractVersion })));
}

export function toolRefKey(ref: ToolRef): string {
  return `${ref.canonicalId}@${String(ref.contractVersion)}`;
}

export function catalogIdentifier(value: CatalogJsonValue | undefined): string {
  const identifier = catalogString(value);
  requireCatalog(/^[a-z][a-z0-9-]{0,63}$/u.test(identifier), "invalid-identity");
  return identifier;
}

export function catalogBindingReference(value: CatalogJsonValue | undefined): string {
  const reference = catalogString(value);
  requireCatalog(/^[a-z][a-z0-9._-]{0,127}$/u.test(reference), "invalid-identity");
  return reference;
}

export function catalogAlias(value: CatalogJsonValue | undefined): string {
  const alias = catalogString(value);
  requireCatalog(/^[a-z][a-z0-9_]{0,63}$/u.test(alias), "invalid-identity");
  return alias;
}

export function versionRefFrom(value: CatalogJsonValue | undefined): CatalogVersionRef {
  const object = catalogObject(value);
  exactCatalogKeys(object, ["id", "version"]);
  return { id: catalogIdentifier(object.id), version: catalogPositive(object.version) };
}

export function runtimeRefFrom(value: CatalogJsonValue | undefined): CatalogRuntimeRef {
  const object = catalogObject(value);
  exactCatalogKeys(object, ["id", "version"]);
  requireCatalog(validTargetVersion(object.version), "invalid-identity");
  return { id: catalogIdentifier(object.id), version: object.version };
}

export function catalogDigest(value: CatalogJsonValue | undefined): CatalogDigest {
  const digest = catalogString(value);
  requireCatalog(isCatalogDigest(digest), "invalid-identity");
  return digest;
}

export function semanticDigest(
  domain:
    | "keiko.tool-descriptor.v1"
    | "keiko.tool-projection.v1"
    | "keiko.tool-catalog.v1"
    | "keiko.tool-handler-set.v1",
  fields: unknown,
): CatalogDigest {
  const object: CatalogJsonObject = catalogObject(
    domain === "keiko.tool-descriptor.v1" ? copyCatalogJson(fields) : copyCatalogEnvelope(fields),
  );
  requireCatalog(!Object.hasOwn(object, "domain"), "invalid-shape");
  return catalogDigest(sha256Hex(canonicalise({ domain, ...object })));
}
