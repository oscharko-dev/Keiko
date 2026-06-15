// Test-only helpers for the memory evaluation harness (Epic #204 / Issue #215).
//
// Lives under tests/ — picked up by the repo vitest include `tests/**/*.test.ts`. No
// production code consumes this file. Pure utilities only:
//
//   * Branded-id helpers — JSON fixtures store ids as plain strings so they stay
//     human-readable; this module brands them at load time.
//   * `makeRecord` — produces a fully-typed `MemoryRecord` from a partial fixture entry,
//     filling in deterministic defaults so a fixture only has to specify what the scenario
//     actually exercises.
//   * `vaultPort(vault)` — adapts a `MemoryVaultStore` to the `MemoryQueryPort` consumed
//     by the retrieval layer. Tests that prefer an in-memory port can construct it
//     directly without spinning up SQLite.
//   * Fixture loader — reads a JSON fixture file synchronously (deterministic; node:fs
//     readFileSync) and parses each entry into typed records + optional edges.
//
// Every clock-touching helper takes an injected `nowMs`; nothing in this file reads the
// wall clock or invokes randomness, so two consecutive eval runs see byte-identical inputs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";

import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryEdgeKind,
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  MemoryScope,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  MemoryType,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryQueryPort, ListByScopeOptions } from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

// ─── Brand helpers ───────────────────────────────────────────────────────────
// One cast per brand so a `grep -n " as UserId"` finds every site. Matches the convention
// used in packages/keiko-memory-retrieval/src/_support.ts.
export const userId = (s: string): UserId => s as UserId;
export const workspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const projectId = (s: string): ProjectId => s as ProjectId;
export const workflowDefinitionId = (s: string): WorkflowDefinitionId => s as WorkflowDefinitionId;
export const memoryId = (s: string): MemoryId => s as MemoryId;
export const edgeId = (s: string): MemoryEdgeId => s as MemoryEdgeId;
export const reviewerId = (s: string): MemoryReviewerId => s as MemoryReviewerId;

export const userScope = (id = "user-alice"): MemoryScope => ({
  kind: "user",
  userId: userId(id),
});
export const projectScopeOf = (id = "proj-keiko"): MemoryScope => ({
  kind: "project",
  projectId: projectId(id),
});
export const workspaceScopeOf = (id = "ws-main"): MemoryScope => ({
  kind: "workspace",
  workspaceId: workspaceId(id),
});
export const workflowScopeOf = (id = "wf-investigate"): MemoryScope => ({
  kind: "workflow",
  workflowDefinitionId: workflowDefinitionId(id),
});

// ─── Fixture record shape ────────────────────────────────────────────────────
// Mirrors `MemoryRecord` minus brand types so JSON parses cleanly. Anything optional in
// the fixture is filled by `makeRecord` from a deterministic default.

export type FixtureScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "workflow"; readonly workflowDefinitionId: string }
  | { readonly kind: "global" };

export interface FixtureRecord {
  readonly id: string;
  readonly scope: FixtureScope;
  readonly type: MemoryType;
  readonly body: string;
  readonly status?: MemoryStatus;
  readonly pinned?: boolean;
  readonly tags?: readonly string[];
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

export interface FixtureEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind?: MemoryEdgeKind;
  readonly createdAt?: number;
}

export interface MemoryEvalFixture {
  readonly id: string;
  readonly description: string;
  readonly memories: readonly FixtureRecord[];
  readonly edges?: readonly FixtureEdge[];
}

// ─── Branding helpers for fixture scopes ─────────────────────────────────────
export function brandScope(scope: FixtureScope): MemoryScope {
  switch (scope.kind) {
    case "user":
      return { kind: "user", userId: userId(scope.userId) };
    case "workspace":
      return { kind: "workspace", workspaceId: workspaceId(scope.workspaceId) };
    case "project":
      return { kind: "project", projectId: projectId(scope.projectId) };
    case "workflow":
      return {
        kind: "workflow",
        workflowDefinitionId: workflowDefinitionId(scope.workflowDefinitionId),
      };
    case "global":
      return { kind: "global" };
  }
}

// ─── makeRecord — fill defaults so a fixture only declares what it exercises ─
const DEFAULT_TIMESTAMP = 1_700_000_000_000;

function provenanceOf(record: FixtureRecord): MemoryRecord["provenance"] {
  return {
    sourceKind: record.sourceKind ?? "explicit-user-instruction",
    capturedAt: record.capturedAt ?? DEFAULT_TIMESTAMP,
    confidence: record.confidence ?? 0.85,
    sensitivity: record.sensitivity ?? "public",
  };
}

function validityOf(record: FixtureRecord): MemoryRecord["validity"] {
  const validFrom = record.validFrom ?? DEFAULT_TIMESTAMP;
  return record.validUntil === undefined
    ? { validFrom }
    : { validFrom, validUntil: record.validUntil };
}

export function makeRecord(record: FixtureRecord): MemoryRecord {
  const staleReason = record.staleReason;
  const created = record.createdAt ?? DEFAULT_TIMESTAMP;
  const updated = record.updatedAt ?? created;
  return {
    id: memoryId(record.id),
    schemaVersion: "1",
    scope: brandScope(record.scope),
    type: record.type,
    body: record.body,
    provenance: provenanceOf(record),
    validity: validityOf(record),
    status: record.status ?? "accepted",
    pinned: record.pinned ?? false,
    tags: record.tags ?? [],
    createdAt: created,
    updatedAt: updated,
    ...(staleReason === undefined ? {} : { staleReason }),
  };
}

export function makeEdge(edge: FixtureEdge): MemoryEdge {
  return {
    id: edgeId(edge.id),
    schemaVersion: "1",
    fromMemoryId: memoryId(edge.from),
    toMemoryId: memoryId(edge.to),
    kind: edge.kind ?? "related",
    createdAt: edge.createdAt ?? DEFAULT_TIMESTAMP,
  };
}

// ─── Vault → MemoryQueryPort adapter ─────────────────────────────────────────
// The retrieval layer never imports the vault — by design (ADR-0019 leaf rule). Scenario
// tests that want a real SQLite vault use this adapter so the same scenario can be
// re-run later against a different storage implementation if needed.
export function vaultPort(vault: MemoryVaultStore): MemoryQueryPort {
  return {
    listByScope: (scope: MemoryScope, options?: ListByScopeOptions): readonly MemoryRecord[] =>
      vault.listMemoriesByScope(scope, {
        includeExpired: true,
        limit: options?.maxResults ?? 500,
      }),
    listOutgoingEdges: (id: MemoryId): readonly MemoryEdge[] => vault.listOutgoingEdges(id),
    listIncomingEdges: (id: MemoryId): readonly MemoryEdge[] => vault.listIncomingEdges(id),
  };
}

// ─── In-memory port — for scenarios that do not need SQLite ──────────────────
// Mirrors the spy-port pattern in packages/keiko-memory-retrieval/src/retrieve.test.ts so
// scenario tests can audit which scopes were touched (cross-scope-isolation needs this).
export interface SpyPort extends MemoryQueryPort {
  readonly calledScopes: readonly MemoryScope[];
}

export function spyPortFromRecords(records: readonly MemoryRecord[]): SpyPort {
  const calls: MemoryScope[] = [];
  const edgeMap = new Map<MemoryId, MemoryEdge[]>();
  const port: SpyPort = {
    calledScopes: calls,
    listByScope: (scope: MemoryScope): readonly MemoryRecord[] => {
      calls.push(scope);
      return records.filter((r) => sameScope(r.scope, scope));
    },
    listOutgoingEdges: (id: MemoryId): readonly MemoryEdge[] => edgeMap.get(id) ?? [],
    listIncomingEdges: (id: MemoryId): readonly MemoryEdge[] => {
      const out: MemoryEdge[] = [];
      for (const edges of edgeMap.values()) {
        for (const e of edges) if (e.toMemoryId === id) out.push(e);
      }
      return out;
    },
  };
  return port;
}

export function spyPortFromRecordsAndEdges(
  records: readonly MemoryRecord[],
  edges: readonly MemoryEdge[],
): SpyPort {
  const calls: MemoryScope[] = [];
  const byFrom = new Map<MemoryId, MemoryEdge[]>();
  for (const e of edges) {
    const list = byFrom.get(e.fromMemoryId) ?? [];
    list.push(e);
    byFrom.set(e.fromMemoryId, list);
  }
  return {
    calledScopes: calls,
    listByScope: (scope: MemoryScope): readonly MemoryRecord[] => {
      calls.push(scope);
      return records.filter((r) => sameScope(r.scope, scope));
    },
    listOutgoingEdges: (id: MemoryId): readonly MemoryEdge[] => byFrom.get(id) ?? [],
    listIncomingEdges: (id: MemoryId): readonly MemoryEdge[] => {
      const out: MemoryEdge[] = [];
      for (const list of byFrom.values()) {
        for (const e of list) if (e.toMemoryId === id) out.push(e);
      }
      return out;
    },
  };
}

// Canonical "kind:coordinate" projection collapses the per-kind branching the way
// packages/keiko-memory-governance/src/forget.ts scopeCoordinateKey does. Two scopes are
// the same iff their projections are byte-equal.
function scopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
    case "global":
      return "global:";
  }
}

export function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

// ─── Fixture loading ─────────────────────────────────────────────────────────
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function isFixtureScope(value: unknown): value is FixtureScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  const kind = scope.kind;
  switch (kind) {
    case "user":
      return typeof scope.userId === "string";
    case "workspace":
      return typeof scope.workspaceId === "string";
    case "project":
      return typeof scope.projectId === "string";
    case "workflow":
      return typeof scope.workflowDefinitionId === "string";
    case "global":
      return true;
    default:
      return false;
  }
}

function isFixtureRecord(value: unknown): value is FixtureRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.body === "string" &&
    typeof r.type === "string" &&
    isFixtureScope(r.scope)
  );
}

function isMemoryEvalFixture(value: unknown): value is MemoryEvalFixture {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.id !== "string" || typeof f.description !== "string") return false;
  if (!Array.isArray(f.memories)) return false;
  for (const m of f.memories) if (!isFixtureRecord(m)) return false;
  return true;
}

export function loadFixture(filename: string): readonly MemoryEvalFixture[] {
  const text = readFileSync(join(FIXTURE_DIR, filename), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`fixture ${filename} must be a JSON array`);
  }
  const out: MemoryEvalFixture[] = [];
  for (const entry of parsed) {
    if (!isMemoryEvalFixture(entry)) {
      throw new Error(`fixture ${filename} contains a malformed entry`);
    }
    out.push(entry);
  }
  return out;
}

// ─── Fixed clock + counter ID source ─────────────────────────────────────────
export const FIXED_NOW_MS = DEFAULT_TIMESTAMP;
export const fixedClock = (): number => FIXED_NOW_MS;
export const TEST_VAULT_KEY: Buffer = Buffer.alloc(32, 7);

export function counterIdSource(prefix: string): () => string {
  let n = 0;
  return (): string => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}
