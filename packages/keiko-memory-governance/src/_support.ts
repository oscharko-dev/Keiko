// Test-only fixtures and helpers. Excluded from the build (see tsconfig `exclude`).
//
// `makeRecord` mirrors the `baseRecord` factory used by keiko-memory-consolidation tests
// so governance tests stay aligned with the shared MemoryRecord shape downstream packages
// already rely on. Callers override fields with a shallow patch.

import type {
  ConversationId,
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  MemoryScope,
  ProjectId,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";

import type { GovernanceContext } from "./types.js";

// Non-null assertion helper used by tests under noUncheckedIndexedAccess. Throws (not
// asserts) so a missing fixture index is a loud test failure, not a silent undefined.
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

export function projectScope(projectId: string): MemoryScope {
  return { kind: "project", projectId: projectId as ProjectId };
}

export function ctx(overrides: Partial<GovernanceContext> = {}): GovernanceContext {
  return {
    reviewerId: overrides.reviewerId ?? ("rev-1" as MemoryReviewerId),
    nowMs: overrides.nowMs ?? FIXED_NOW_MS,
  };
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
  readonly sourceConversationId?: string;
}

function buildProvenance(
  overrides: RecordOverrides,
  createdAt: number,
): MemoryRecord["provenance"] {
  const base: MemoryRecord["provenance"] = {
    sourceKind: "explicit-user-instruction",
    capturedAt: overrides.capturedAt ?? createdAt,
    confidence: overrides.confidence ?? 0.9,
    sensitivity: "confidential",
  };
  if (overrides.sourceConversationId === undefined) return base;
  return {
    ...base,
    sourceConversationId: overrides.sourceConversationId as unknown as ConversationId,
  };
}

function buildValidity(overrides: RecordOverrides, createdAt: number): MemoryRecord["validity"] {
  const validFrom = overrides.validFrom ?? createdAt;
  return overrides.validUntil === undefined
    ? { validFrom }
    : { validFrom, validUntil: overrides.validUntil };
}

interface CoreFields {
  readonly id: MemoryId;
  readonly scope: MemoryScope;
  readonly type: MemoryRecord["type"];
  readonly body: string;
  readonly status: MemoryRecord["status"];
  readonly pinned: boolean;
  readonly tags: readonly string[];
}

function buildCoreFields(overrides: RecordOverrides): CoreFields {
  return {
    id: (overrides.id ?? "m-1") as MemoryId,
    scope: overrides.scope ?? userScope("u-1"),
    type: overrides.type ?? "preference",
    body: overrides.body ?? "prefers dark mode",
    status: overrides.status ?? "accepted",
    pinned: overrides.pinned ?? false,
    tags: overrides.tags ?? [],
  };
}

export function makeRecord(overrides: RecordOverrides = {}): MemoryRecord {
  const createdAt = overrides.createdAt ?? FIXED_NOW_MS;
  const core = buildCoreFields(overrides);
  return {
    ...core,
    schemaVersion: "1",
    provenance: buildProvenance(overrides, createdAt),
    validity: buildValidity(overrides, createdAt),
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}
