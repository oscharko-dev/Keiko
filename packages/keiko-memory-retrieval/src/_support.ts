// Test-only fixture builders. Excluded from the published build by tsconfig.json's
// `**/_support.ts` exclude. Kept in src/ rather than under tests/ so package-private
// types can be reached without re-exporting them on the public barrel.
//
// All branded IDs are forged via a single `brand<T>(s)` helper. The vault validators are
// NOT invoked here because we want tests that exercise the ranker against shapes outside
// the validator's policy (e.g. confidence at 0 or out-of-band staleReason values) without
// fighting the validator.

import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryEdgeKind,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  MemoryType,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";

// Per-brand cast helpers. The lint rule `no-unnecessary-type-parameters` rejects a single
// generic `brand<T>(s)` because T is used only once; per-brand helpers are clearer at the
// call site anyway. Each cast crosses the brand boundary explicitly so a future refactor
// that runs `grep -n " as UserId"` finds every site.
export const userId = (s: string): UserId => s as UserId;
export const workspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const projectId = (s: string): ProjectId => s as ProjectId;
export const memoryId = (s: string): MemoryId => s as MemoryId;
export const edgeId = (s: string): MemoryEdgeId => s as MemoryEdgeId;

export const userScope = (id = "u1"): MemoryScope => ({ kind: "user", userId: userId(id) });
export const projectScope = (id = "p1"): MemoryScope => ({
  kind: "project",
  projectId: projectId(id),
});
export const workspaceScope = (id = "w1"): MemoryScope => ({
  kind: "workspace",
  workspaceId: workspaceId(id),
});

export interface BuildRecordOptions {
  readonly id?: string;
  readonly scope?: MemoryScope;
  readonly type?: MemoryType;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly status?: MemoryStatus;
  readonly pinned?: boolean;
  readonly confidence?: number;
  readonly sensitivity?: MemorySensitivity;
  readonly sourceKind?: MemorySourceKind;
  readonly capturedAt?: number;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly staleReason?: string;
}

function buildProvenance(options: BuildRecordOptions): MemoryRecord["provenance"] {
  return {
    sourceKind: options.sourceKind ?? "explicit-user-instruction",
    capturedAt: options.capturedAt ?? 1_000,
    confidence: options.confidence ?? 0.8,
    sensitivity: options.sensitivity ?? "public",
  };
}

function buildValidity(options: BuildRecordOptions): MemoryRecord["validity"] {
  const validFrom = options.validFrom ?? 1_000;
  if (options.validUntil === undefined) return { validFrom };
  return { validFrom, validUntil: options.validUntil };
}

interface BuildRecordCore {
  readonly id: MemoryRecord["id"];
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly body: string;
  readonly status: MemoryStatus;
  readonly pinned: boolean;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

function resolveCore(options: BuildRecordOptions): BuildRecordCore {
  return {
    id: memoryId(options.id ?? "m1"),
    scope: options.scope ?? userScope(),
    type: options.type ?? "semantic-fact",
    body: options.body ?? "default body text",
    status: options.status ?? "accepted",
    pinned: options.pinned ?? false,
    tags: options.tags ?? [],
    createdAt: options.createdAt ?? 1_000,
    updatedAt: options.updatedAt ?? 1_000,
  };
}

export function buildRecord(options: BuildRecordOptions = {}): MemoryRecord {
  const core = resolveCore(options);
  const staleReason = options.staleReason;
  return {
    ...core,
    schemaVersion: "1",
    provenance: buildProvenance(options),
    validity: buildValidity(options),
    ...(staleReason === undefined ? {} : { staleReason }),
  };
}

export interface BuildEdgeOptions {
  readonly id?: string;
  readonly from: string;
  readonly to: string;
  readonly kind?: MemoryEdgeKind;
  readonly createdAt?: number;
}

export function buildEdge(options: BuildEdgeOptions): MemoryEdge {
  return {
    id: edgeId(options.id ?? `e-${options.from}-${options.to}`),
    schemaVersion: "1",
    fromMemoryId: memoryId(options.from),
    toMemoryId: memoryId(options.to),
    kind: options.kind ?? "related",
    createdAt: options.createdAt ?? 1_000,
  };
}
