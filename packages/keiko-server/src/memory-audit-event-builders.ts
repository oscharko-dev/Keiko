// Pure helpers for the memory audit handler (#214). Split from memory-audit-handler.ts to
// keep each file under the 400-LOC budget. No IO, no clock reads, no randomness — every
// effect is injected via `BuildContext`. The handler in `memory-audit-handler.ts` owns
// the impure surface (persistence, clock, id generation).

import type {
  MemoryAuditEvent,
  MemoryAuditInitiatorSurface,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
} from "@oscharko-dev/keiko-contracts";
import { MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS } from "@oscharko-dev/keiko-contracts";
import type { MemoryTombstone } from "@oscharko-dev/keiko-memory-vault";

// ─── Constants ────────────────────────────────────────────────────────────────

// Default initiator for vault-derived events. Retrieval/workflow direct emissions use
// their own surface ("memory-center" / "conversation-center" / "workflow").
export const VAULT_DERIVED_SURFACE: MemoryAuditInitiatorSurface = "system";

// ─── Build context ────────────────────────────────────────────────────────────

export interface BuildContext {
  readonly now: () => number;
  readonly newEventId: () => string;
  readonly redactString: (input: string) => string;
}

// ─── Summary boundary ─────────────────────────────────────────────────────────

// Truncates and redacts the summary at the audit boundary. Bound mirrors the
// MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS contract constant.
export function safeSummary(input: string, redactString: (s: string) => string): string {
  const redacted = redactString(input);
  if (redacted.length <= MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS) {
    return redacted;
  }
  return redacted.slice(0, MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS);
}

// ─── Classification ───────────────────────────────────────────────────────────

// One-record discriminated-union member kinds that share the same `memoryId + scope`
// envelope shape. Each builds via `buildSingleRecordEvent` so the discriminator narrows
// at the literal level.
export type SingleRecordKind =
  | "memory:accepted"
  | "memory:rejected"
  | "memory:archived"
  | "memory:pinned"
  | "memory:unpinned"
  | "memory:updated";

export interface UpdateClassification {
  readonly kind: SingleRecordKind;
  readonly label: string;
}

function classifyStatusTransition(
  previous: MemoryStatus | undefined,
  next: MemoryStatus,
): UpdateClassification | undefined {
  if (previous === next) {
    return undefined;
  }
  if (next === "accepted") {
    return { kind: "memory:accepted", label: "status -> accepted" };
  }
  if (next === "rejected") {
    return { kind: "memory:rejected", label: "status -> rejected" };
  }
  if (next === "archived") {
    return { kind: "memory:archived", label: "status -> archived" };
  }
  // A vault-bridge `memory:updated` with new status="superseded" doesn't know the
  // supersedor's id; the supersession envelope requires both old + new. Direct emitters
  // (consolidation #208) that know both ids should call `recordMemoryAudit` with kind
  // "memory:superseded" explicitly. From the bridge we fall through to a plain
  // `memory:updated` so the audit trail still records the state change.
  return undefined;
}

function classifyPinTransition(
  previousPinned: boolean | undefined,
  nextPinned: boolean,
): UpdateClassification | undefined {
  if (previousPinned === nextPinned) {
    return undefined;
  }
  return nextPinned
    ? { kind: "memory:pinned", label: "pinned -> true" }
    : { kind: "memory:unpinned", label: "pinned -> false" };
}

export function classifyUpdate(
  previousStatus: MemoryStatus | undefined,
  previousPinned: boolean | undefined,
  record: MemoryRecord,
): UpdateClassification {
  const statusClass = classifyStatusTransition(previousStatus, record.status);
  if (statusClass !== undefined) {
    return statusClass;
  }
  const pinClass = classifyPinTransition(previousPinned, record.pinned);
  if (pinClass !== undefined) {
    return pinClass;
  }
  // No status / pin transition detected: this is a plain content/metadata update.
  return { kind: "memory:updated", label: "metadata updated" };
}

// ─── Event builders ───────────────────────────────────────────────────────────

function buildSingleRecordEvent(
  kind: SingleRecordKind,
  record: MemoryRecord,
  summary: string,
  ctx: BuildContext,
): MemoryAuditEvent {
  const envelope = {
    schemaVersion: "1" as const,
    eventId: ctx.newEventId(),
    occurredAt: ctx.now(),
    initiatorSurface: VAULT_DERIVED_SURFACE,
    summary,
    memoryId: record.id,
    scope: record.scope,
  };
  switch (kind) {
    case "memory:accepted":
      return { ...envelope, kind: "memory:accepted" };
    case "memory:rejected":
      return { ...envelope, kind: "memory:rejected" };
    case "memory:archived":
      return { ...envelope, kind: "memory:archived" };
    case "memory:pinned":
      return { ...envelope, kind: "memory:pinned" };
    case "memory:unpinned":
      return { ...envelope, kind: "memory:unpinned" };
    case "memory:updated":
      return { ...envelope, kind: "memory:updated" };
    default: {
      const never: never = kind;
      return never;
    }
  }
}

export function buildProposedEvent(record: MemoryRecord, ctx: BuildContext): MemoryAuditEvent {
  return {
    schemaVersion: "1",
    kind: "memory:proposed",
    eventId: ctx.newEventId(),
    occurredAt: ctx.now(),
    initiatorSurface: VAULT_DERIVED_SURFACE,
    summary: safeSummary(`memory ${record.id} proposed (type=${record.type})`, ctx.redactString),
    memoryId: record.id,
    scope: record.scope,
  };
}

export function buildInsertedEvent(
  record: MemoryRecord,
  ctx: BuildContext,
): MemoryAuditEvent | undefined {
  // The vault emits `memory:inserted` for any new record, but capture (#207) typically
  // inserts at status="proposed". Acceptance flows insert at status="accepted" only when
  // the bypass-review path is taken (rare). We map the initial status to the closest
  // semantic kind; any inserted-at-terminal status (rejected/forgotten/etc.) is dropped
  // because the audit trail for those flows runs through the operation that produced
  // them, not through the vault insert.
  switch (record.status) {
    case "proposed":
      return buildProposedEvent(record, ctx);
    case "accepted":
      return buildSingleRecordEvent(
        "memory:accepted",
        record,
        safeSummary(
          `memory ${record.id} inserted as accepted (type=${record.type})`,
          ctx.redactString,
        ),
        ctx,
      );
    case "rejected":
    case "superseded":
    case "archived":
    case "forgotten":
    case "conflicted":
    case "expired":
      return undefined;
    default:
      return undefined;
  }
}

export function buildUpdatedEvent(
  record: MemoryRecord,
  previousStatus: MemoryStatus | undefined,
  previousPinned: boolean | undefined,
  ctx: BuildContext,
): MemoryAuditEvent {
  const cls = classifyUpdate(previousStatus, previousPinned, record);
  const summary = safeSummary(`memory ${record.id} ${cls.label}`, ctx.redactString);
  return buildSingleRecordEvent(cls.kind, record, summary, ctx);
}

// Reconstructs the scope object from the tombstone's flat scope-kind + scope-coordinate
// pair. The vault flattens the discriminated union on persist; the audit boundary
// requires the structured shape. The coordinate string IS already the realpath of the
// branded ID (memory-vault writes them this way), so we re-cast at the audit boundary.
function scopeFromTombstone(tombstone: MemoryTombstone): MemoryScope {
  switch (tombstone.scopeKind) {
    case "user":
      return {
        kind: "user",
        userId: tombstone.scopeCoordinate as MemoryScope extends { userId: infer T } ? T : never,
      };
    case "workspace":
      return {
        kind: "workspace",
        workspaceId: tombstone.scopeCoordinate as MemoryScope extends { workspaceId: infer T }
          ? T
          : never,
      };
    case "project":
      return {
        kind: "project",
        projectId: tombstone.scopeCoordinate as MemoryScope extends { projectId: infer T }
          ? T
          : never,
      };
    case "workflow":
      return {
        kind: "workflow",
        workflowDefinitionId: tombstone.scopeCoordinate as MemoryScope extends {
          workflowDefinitionId: infer T;
        }
          ? T
          : never,
      };
    case "global":
      return { kind: "global" };
    default:
      return { kind: "global" };
  }
}

export function buildTombstonedEvent(
  tombstone: MemoryTombstone,
  ctx: BuildContext,
): MemoryAuditEvent {
  return {
    schemaVersion: "1",
    kind: "memory:forgotten",
    eventId: ctx.newEventId(),
    occurredAt: ctx.now(),
    initiatorSurface: VAULT_DERIVED_SURFACE,
    summary: safeSummary(
      `memory ${tombstone.memoryId} forgotten (surface=${tombstone.forgetterSurface})`,
      ctx.redactString,
    ),
    memoryId: tombstone.memoryId,
    scope: scopeFromTombstone(tombstone),
    tombstoned: true,
  };
}
