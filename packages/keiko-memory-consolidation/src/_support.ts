// Test-only fixtures and helpers. Excluded from the build (see tsconfig `exclude`).
//
// `makeRecord` mirrors the `baseRecord` factory used by keiko-memory-vault tests: the same
// scope/type/sensitivity defaults so consolidation tests stay aligned with vault contract
// expectations. Callers override fields with a shallow patch.

import type {
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";

// Non-null assertion helper used by tests under noUncheckedIndexedAccess. Throws (not asserts)
// so a missing fixture index is a loud test failure, not a silent undefined.
export function must<T>(value: T | undefined, message = "expected defined value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

export const FIXED_NOW_MS = 1_700_000_000_000;

export function userScope(userId: string): MemoryScope {
  return { kind: "user", userId: userId as UserId };
}

export interface RecordOverrides {
  readonly id?: string;
  readonly scope?: MemoryScope;
  readonly type?: MemoryRecord["type"];
  readonly body?: string;
  readonly confidence?: number;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly status?: MemoryRecord["status"];
  readonly pinned?: boolean;
  readonly tags?: readonly string[];
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly capturedAt?: number;
}

export function makeRecord(overrides: RecordOverrides = {}): MemoryRecord {
  const createdAt = overrides.createdAt ?? FIXED_NOW_MS;
  return {
    id: (overrides.id ?? "m-1") as MemoryId,
    schemaVersion: "1",
    scope: overrides.scope ?? userScope("u-1"),
    type: overrides.type ?? "preference",
    body: overrides.body ?? "prefers dark mode",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: overrides.capturedAt ?? createdAt,
      confidence: overrides.confidence ?? 0.9,
      sensitivity: "confidential",
    },
    validity:
      overrides.validUntil === undefined
        ? { validFrom: overrides.validFrom ?? createdAt }
        : { validFrom: overrides.validFrom ?? createdAt, validUntil: overrides.validUntil },
    status: overrides.status ?? "accepted",
    pinned: overrides.pinned ?? false,
    tags: overrides.tags ?? [],
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}

// Deterministic id factories used by tests. Each call returns the next "edge-N" / "rv-N" id.
export function makeIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${String(counter)}`;
  };
}

export function makeEdgeIdFactory(): () => MemoryEdgeId {
  const next = makeIdFactory("edge");
  return () => next() as MemoryEdgeId;
}
