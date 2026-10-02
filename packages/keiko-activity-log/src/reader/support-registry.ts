import { inflateSync } from "node:zlib";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_OPERATION_REGISTRY,
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  MAX_DECODED_SUPPORT_REGISTRY_SNAPSHOT_BYTES,
  SUPPORT_RELEASE_REGISTRY_SNAPSHOTS,
} from "./support-registry-history.generated.js";

interface ReaderClassCoverage {
  readonly failureClass: string;
  readonly lifecycleOperations: Readonly<Partial<Record<string, readonly string[]>>>;
}

/** Trusted executable inputs shipped with Keiko; never supplied by a received report. */
export interface SupportReaderRegistry {
  readonly registryVersion: number;
  readonly schemaDigest: string;
  readonly catalogDigest: string;
  readonly operations: ReadonlyMap<string, ActivityLogOperationRegistration>;
  readonly classes: ReadonlyMap<string, ReaderClassCoverage>;
}

interface SupportRegistrySnapshot {
  readonly registryVersion: number;
  readonly schemaDigest: string;
  readonly catalogDigest: string;
  readonly operations: readonly ActivityLogOperationRegistration[];
  readonly classes: readonly ReaderClassCoverage[];
}

function supportReaderRegistry(snapshot: SupportRegistrySnapshot): SupportReaderRegistry {
  return {
    registryVersion: snapshot.registryVersion,
    schemaDigest: snapshot.schemaDigest,
    catalogDigest: snapshot.catalogDigest,
    operations: new Map(snapshot.operations.map((operation) => [operation.op, operation])),
    classes: new Map(snapshot.classes.map((coverage) => [coverage.failureClass, coverage])),
  };
}

export const CURRENT_SUPPORT_REGISTRY = supportReaderRegistry({
  registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
  schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
  catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
  operations: ACTIVITY_LOG_OPERATION_REGISTRY,
  classes: ACTIVITY_LOG_FAILURE_CLASS_COVERAGE.classes,
});

export interface SupportRegistryIdentity {
  readonly registryVersion: number;
  readonly schemaDigest: string;
  readonly catalogDigest: string;
}

function sameIdentity(left: SupportRegistryIdentity, right: SupportRegistryIdentity): boolean {
  return (
    left.registryVersion === right.registryVersion &&
    left.schemaDigest === right.schemaDigest &&
    left.catalogDigest === right.catalogDigest
  );
}

const decodedRegistries = new Map<string, SupportReaderRegistry>();

/**
 * The exact trusted registry a recorded identity names: the current one, or one supported
 * release's archived snapshot, inflated once within its decoded ceiling. Undefined for any other
 * identity: a report never supplies its own schema.
 */
export function findSupportRegistry(
  identity: SupportRegistryIdentity,
): SupportReaderRegistry | undefined {
  if (sameIdentity(CURRENT_SUPPORT_REGISTRY, identity)) return CURRENT_SUPPORT_REGISTRY;
  const snapshot = SUPPORT_RELEASE_REGISTRY_SNAPSHOTS.find((candidate) =>
    sameIdentity(candidate, identity),
  );
  if (snapshot === undefined) return undefined;
  const cached = decodedRegistries.get(snapshot.catalogDigest);
  if (cached !== undefined) return cached;
  const decoded = JSON.parse(
    inflateSync(Buffer.from(snapshot.payload, "base64"), {
      maxOutputLength: MAX_DECODED_SUPPORT_REGISTRY_SNAPSHOT_BYTES,
    }).toString("utf8"),
  ) as SupportRegistrySnapshot;
  const registry = supportReaderRegistry(decoded);
  decodedRegistries.set(snapshot.catalogDigest, registry);
  return registry;
}
