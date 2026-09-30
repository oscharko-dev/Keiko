import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_OPERATION_REGISTRY,
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

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

export interface SupportRegistrySnapshot {
  readonly registryVersion: number;
  readonly schemaDigest: string;
  readonly catalogDigest: string;
  readonly operations: readonly ActivityLogOperationRegistration[];
  readonly classes: readonly ReaderClassCoverage[];
}

export function supportReaderRegistry(snapshot: SupportRegistrySnapshot): SupportReaderRegistry {
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
