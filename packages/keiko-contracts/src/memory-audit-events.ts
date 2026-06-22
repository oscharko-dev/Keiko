// Memory audit event surface for the Governed Enterprise Memory Vault (Epic #204, Issue
// #214). Pure types only — no IO, no clock reads, no randomness. Leaf-package rule
// (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports.
//
// `MemoryAuditEvent` is the AUDIT-LAYER projection of the vault's structural `MemoryEvent`
// (defined inside keiko-memory-vault). The vault emits low-level state-change events
// ("memory:inserted", "memory:updated", "memory:deleted", "memory:tombstoned", "edge:*",
// "embedding:upserted"); the audit bridge (`keiko-server/memory-audit-handler`) MAPS each
// structural event into one of the SEMANTIC kinds in this file by reading the new record's
// status, comparing against a previous-status cache, and classifying the transition.
//
// Retrieval/workflow-specific kinds are NOT emitted by the vault. They are surfaced here
// so the audit ledger has a single closed type for every memory-touching audit signal.
// Retrieval and workflow integration layers emit them directly via `recordMemoryAudit(...)`.
// They are listed in `MEMORY_AUDIT_EVENT_KINDS` so the closed enum is stable across schema
// versions.
//
// Audit invariant (mirrors `MemoryAuditRecord`): NEVER carry raw memory body or payload.
// `summary` is a short, REDACTED rationale (bounded length). `scope` and IDs are
// non-secret; scope-coordinate strings are run through the audit redactor at persist time
// in case a user-supplied identifier happens to match a credential shape.

import type { MemoryAuditInitiatorSurface, MemoryId, MemoryScope } from "./memory-barrel.js";

// ─── Schema version ───────────────────────────────────────────────────────────
// Pinned to "1". A breaking change introduces a NEW literal member rather than mutating
// "1" — the same evolution rule as `MEMORY_SCHEMA_VERSION` and the other contract surfaces.
export const MEMORY_AUDIT_EVENT_SCHEMA_VERSION = "1" as const;

// Maximum length for `summary`. Audit ledger summaries are dense human-readable strings,
// not bodies. The bound matches `MEMORY_SUMMARY_MAX_CHARS` (240 chars) used in the audit
// record validator so the two audit surfaces stay aligned at the boundary.
export const MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS = 240;

// ─── Closed enum of audit event kinds ────────────────────────────────────────
// Every memory-touching audit signal — whether vault-derived or directly emitted by a
// retrieval/workflow layer — maps to exactly one of these kinds. Adding a new kind here
// also extends the discriminated union below; the validator at the audit boundary refuses
// any unknown kind.
export type MemoryAuditEventKind =
  | "memory:proposed"
  | "memory:accepted"
  | "memory:rejected"
  | "memory:updated"
  | "memory:superseded"
  | "memory:pinned"
  | "memory:unpinned"
  | "memory:archived"
  | "memory:forgotten"
  | "memory:retrieved"
  | "memory:workflow-used"
  | "memory:workflow-omitted"
  | "memory:workflow-write-candidate";

export const MEMORY_AUDIT_EVENT_KINDS: readonly MemoryAuditEventKind[] = [
  "memory:proposed",
  "memory:accepted",
  "memory:rejected",
  "memory:updated",
  "memory:superseded",
  "memory:pinned",
  "memory:unpinned",
  "memory:archived",
  "memory:forgotten",
  "memory:retrieved",
  "memory:workflow-used",
  "memory:workflow-omitted",
  "memory:workflow-write-candidate",
] as const;

// ─── Common envelope ─────────────────────────────────────────────────────────
// Pulled out of the union members so every kind carries the same identifying fields.
// `summary` is REDACTED before the event reaches this type at the audit boundary; the
// type-level invariant is "non-secret short rationale". `memoryIds` is `readonly` and
// non-empty for every kind that names individual memories.
interface MemoryAuditEventEnvelope {
  readonly schemaVersion: typeof MEMORY_AUDIT_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly occurredAt: number;
  readonly initiatorSurface: MemoryAuditInitiatorSurface;
  readonly summary: string;
}

// ─── Discriminated union ──────────────────────────────────────────────────────
// Each member adds the minimum extra context the audit reader needs to make sense of the
// event without dipping into the record store. `memoryId` + `scope` for single-record
// kinds; `oldMemoryId` + `newMemoryId` for supersession; `scopes` + `matchedMemoryIds`
// for retrieval; `workflowRunId` + `usedMemoryIds` for workflow use; omitted/workflow
// candidate events carry IDs and bounded reasons only, never raw memory bodies.
export type MemoryAuditEvent =
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:proposed";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:accepted";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:rejected";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:updated";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:superseded";
      readonly oldMemoryId: MemoryId;
      readonly newMemoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:pinned";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:unpinned";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:archived";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:forgotten";
      readonly memoryId: MemoryId;
      readonly scope: MemoryScope;
      readonly tombstoned: boolean;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:retrieved";
      readonly scopes: readonly MemoryScope[];
      readonly matchedMemoryIds: readonly MemoryId[];
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:workflow-used";
      readonly workflowRunId: string;
      readonly usedMemoryIds: readonly MemoryId[];
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:workflow-omitted";
      readonly workflowRunId: string;
      readonly scopes: readonly MemoryScope[];
      readonly omittedMemoryId: MemoryId;
      readonly reason: string;
    })
  | (MemoryAuditEventEnvelope & {
      readonly kind: "memory:workflow-write-candidate";
      readonly workflowRunId: string;
      readonly source: "workflow-success" | "workflow-correction";
      readonly scope: MemoryScope;
      readonly proposedMemoryIds: readonly MemoryId[];
    });
