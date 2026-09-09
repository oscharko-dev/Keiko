import {
  TOOL_CATALOG_LIMITS,
  type CatalogCompatibility,
  type CatalogCompatibilityEndpoint,
  type CatalogJsonValue,
  type ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  catalogObject,
  catalogPositive,
  catalogString,
  copyCatalogJson,
  exactCatalogKeys,
} from "./json.js";
import { verifyToolDescriptor } from "./descriptor.js";
import {
  catalogDigest,
  runtimeRefFrom,
  toolRefFrom,
  toolRefKey,
  versionRefFrom,
} from "./identity.js";
import { requireCatalog } from "./errors.js";

function endpoint(value: CatalogJsonValue | undefined): CatalogCompatibilityEndpoint {
  const object = catalogObject(value);
  exactCatalogKeys(object, ["toolRef", "descriptorDigest"]);
  return {
    toolRef: toolRefFrom(object.toolRef),
    descriptorDigest: catalogDigest(object.descriptorDigest),
  };
}

export function compatibilityFrom(value: CatalogJsonValue): CatalogCompatibility {
  const object = catalogObject(value);
  exactCatalogKeys(object, [
    "from",
    "to",
    "profile",
    "adapter",
    "transformId",
    "ownerIssue",
    "expiresAt",
    "removalIssue",
  ]);
  requireCatalog(object.transformId === "identity-v1", "invalid-compatibility");
  const expiresAt = catalogString(object.expiresAt);
  const expiry = Date.parse(expiresAt);
  requireCatalog(
    Number.isFinite(expiry) && new Date(expiry).toISOString() === expiresAt,
    "invalid-compatibility",
  );
  const from = endpoint(object.from);
  const to = endpoint(object.to);
  requireCatalog(
    from.toolRef.canonicalId === to.toolRef.canonicalId &&
      to.toolRef.contractVersion >= from.toolRef.contractVersion,
    "incompatible-version",
  );
  return {
    from,
    to,
    expiresAt,
    profile: versionRefFrom(object.profile),
    adapter: runtimeRefFrom(object.adapter),
    transformId: "identity-v1",
    ownerIssue: catalogPositive(object.ownerIssue),
    removalIssue: catalogPositive(object.removalIssue),
  };
}

/** Recheck a verified entry on every invocation using the binding owner's trusted clock. */
export function assertCompatibilityTime(
  source: CatalogCompatibility,
  referenceTimeMs: number,
): void {
  const entry = compatibilityFrom(copyCatalogJson(source));
  requireCatalog(
    Number.isSafeInteger(referenceTimeMs) && referenceTimeMs >= 0,
    "invalid-compatibility",
  );
  const remaining = Date.parse(entry.expiresAt) - referenceTimeMs;
  requireCatalog(remaining > 0, "expired-compatibility");
  requireCatalog(
    remaining <= TOOL_CATALOG_LIMITS.maxCompatibilityLifetimeMs,
    "invalid-compatibility",
  );
}

function transformSemantics(descriptor: ToolDescriptor): unknown {
  return {
    inputSchema: descriptor.inputSchema,
    resultSchema: descriptor.resultSchema,
    effects: descriptor.effects,
    actionMapping: descriptor.actionMapping,
    policyReferences: descriptor.policyReferences,
    handlerRequirement: descriptor.handlerRequirement,
    idempotency: descriptor.idempotency,
    cancellation: descriptor.cancellation,
  };
}

/** Only an explicitly selected, exact, non-widening identity transform exists in version 1. */
export function assertIdentityCompatibility(
  source: CatalogCompatibility,
  sourceFrom: ToolDescriptor,
  sourceTo: ToolDescriptor,
  referenceTimeMs: number,
): void {
  const entry = compatibilityFrom(copyCatalogJson(source));
  const from = verifyToolDescriptor(sourceFrom);
  const to = verifyToolDescriptor(sourceTo);
  assertCompatibilityTime(entry, referenceTimeMs);
  requireCatalog(
    toolRefKey(from.toolRef) === toolRefKey(entry.from.toolRef) &&
      from.descriptorDigest === entry.from.descriptorDigest,
    "invalid-compatibility",
  );
  requireCatalog(
    toolRefKey(to.toolRef) === toolRefKey(entry.to.toolRef) &&
      to.descriptorDigest === entry.to.descriptorDigest,
    "invalid-compatibility",
  );
  requireCatalog(
    canonicalise(transformSemantics(from)) === canonicalise(transformSemantics(to)),
    "invalid-compatibility",
  );
  requireCatalog(
    Object.keys(to.bounds).every(
      (key) =>
        to.bounds[key as keyof typeof to.bounds] <= from.bounds[key as keyof typeof from.bounds],
    ),
    "invalid-compatibility",
  );
}
