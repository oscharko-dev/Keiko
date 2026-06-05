// Memory audit handler (Epic #204, Issue #214).
//
// Bridges the vault's structural `MemoryEvent` (memory:inserted / memory:updated /
// memory:deleted / memory:tombstoned / edge:* / embedding:upserted) into the SEMANTIC
// `MemoryAuditEvent` surface defined in @oscharko-dev/keiko-contracts. The handler:
//
//   1. Maps each structural event to one or more semantic kinds by reading the new
//      record's status, pinned flag, and comparing against an in-memory
//      `previousStatus: Map<MemoryId, MemoryStatus>` for transition derivation.
//   2. Builds a redacted summary string (via the BFF redactString closure).
//   3. Appends the audit event to a date-bucketed JSON manifest in the existing
//      keiko-evidence ledger (runId = `memory-audit-YYYY-MM-DD`).
//
// Persistence shape: ONE manifest per UTC date. `EvidenceStore.put()` overwrites, so the
// handler reads-appends-writes. Single-process BFF makes this safe; documented limit.
// A multi-process deployment would lose audit events under concurrent writes.
//
// Failure mode: persistence errors are caught and logged to console.error; the handler
// never throws. An audit-persistence failure must NEVER break the user's memory mutation.
//
// Known limitation: the `previousStatus` map is in-memory only. After a server restart the
// first `memory:updated` for any record lacks transition context and is classified as a
// plain `memory:updated` (not promoted to `memory:accepted` / `memory:archived` / etc.).
// The downstream record is captured fully — only the kind classification is degraded.
//
// Edge and embedding events are NOT bridged (out of audit scope per the audit invariant
// in @oscharko-dev/keiko-contracts/memory: audit records carry no body or payload, and
// edges + embeddings encode structural derivations the body-level audit already covers
// via the related record mutations).
//
// "memory:retrieved" and "memory:workflow-used" kinds are NOT vault-derived. The
// `recordMemoryAudit()` helper exported below is the single emission point for those
// kinds; the retrieval and workflow packages adopt the audit boundary in a follow-up.

import { randomUUID } from "node:crypto";
import type { MemoryAuditEvent, MemoryId, MemoryStatus } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { MemoryEvent } from "@oscharko-dev/keiko-memory-vault";
import {
  buildInsertedEvent,
  buildTombstonedEvent,
  buildUpdatedEvent,
  type BuildContext,
} from "./memory-audit-event-builders.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MemoryAuditHandlerOptions {
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (input: string) => string;
  // Optional clock; defaults to Date.now. Injected so tests get deterministic occurredAt.
  readonly now?: () => number;
  // Optional event-id factory; defaults to randomUUID. Injected so tests get stable IDs.
  readonly newEventId?: () => string;
  // Optional sink for persistence errors; defaults to console.error. Tests inject a spy.
  readonly onPersistError?: (error: unknown) => void;
}

export type MemoryAuditHandler = (event: MemoryEvent) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const RUNID_PREFIX = "memory-audit-";

// ─── Pure helpers ─────────────────────────────────────────────────────────────

// UTC date-bucket key. Stable across timezones; the audit ledger is local-only so a single
// UTC bucket is unambiguous. Always 10 chars (`YYYY-MM-DD`), which combined with the
// 13-char prefix yields a 23-char runId well under MAX_RUN_ID_LENGTH (256).
export function auditRunIdFor(nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  // ISO format is `YYYY-MM-DDTHH:mm:ss.sssZ`; slice [0,10] is the date.
  return `${RUNID_PREFIX}${iso.slice(0, 10)}`;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

// Appends a single audit event to the date-bucketed manifest. Read-existing-or-empty,
// parse-or-reset (corrupt-file safe: a parse failure starts a fresh array; the audit
// ledger is append-only by intent, but a corrupt manifest must not break ongoing audit).
function appendAuditEvent(store: EvidenceStore, runId: string, event: MemoryAuditEvent): void {
  const existing = store.get(runId);
  const list = parseExistingEvents(existing);
  list.push(event);
  store.put(runId, JSON.stringify(list));
}

function parseExistingEvents(json: string | undefined): MemoryAuditEvent[] {
  if (json === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      // We trust the manifest is what we wrote; a hostile editor of the file could plant
      // arbitrary JSON, but the file is in the contained evidence dir and the worst case
      // is that the next read sees a corrupt list — handled by the catch.
      return parsed as MemoryAuditEvent[];
    }
    return [];
  } catch {
    return [];
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

export function createMemoryAuditHandler(options: MemoryAuditHandlerOptions): MemoryAuditHandler {
  const now = options.now ?? ((): number => Date.now());
  const newEventId = options.newEventId ?? ((): string => randomUUID());
  const onPersistError =
    options.onPersistError ??
    ((error: unknown): void => {
      // eslint-disable-next-line no-console
      console.error("memory-audit-handler: persistence failed", error);
    });
  const ctx: BuildContext = { now, newEventId, redactString: options.redactString };
  const previousStatus = new Map<MemoryId, MemoryStatus>();
  const previousPinned = new Map<MemoryId, boolean>();

  return (event: MemoryEvent): void => {
    const auditEvent = mapVaultEvent(event, previousStatus, previousPinned, ctx);
    updateStateCache(event, previousStatus, previousPinned);
    if (auditEvent === undefined) {
      return;
    }
    try {
      appendAuditEvent(options.evidenceStore, auditRunIdFor(ctx.now()), auditEvent);
    } catch (error) {
      onPersistError(error);
    }
  };
}

function mapVaultEvent(
  event: MemoryEvent,
  previousStatus: Map<MemoryId, MemoryStatus>,
  previousPinned: Map<MemoryId, boolean>,
  ctx: BuildContext,
): MemoryAuditEvent | undefined {
  switch (event.kind) {
    case "memory:inserted":
      return buildInsertedEvent(event.record, ctx);
    case "memory:updated":
      return buildUpdatedEvent(
        event.record,
        previousStatus.get(event.record.id),
        previousPinned.get(event.record.id),
        ctx,
      );
    case "memory:tombstoned":
      return buildTombstonedEvent(event.tombstone, ctx);
    case "memory:deleted":
    case "edge:inserted":
    case "edge:deleted":
    case "embedding:upserted":
      // memory:deleted is paired with memory:tombstoned for tombstoned deletes; emitting
      // both would double-count. Edge and embedding events are out of audit scope.
      return undefined;
    default:
      return undefined;
  }
}

function updateStateCache(
  event: MemoryEvent,
  previousStatus: Map<MemoryId, MemoryStatus>,
  previousPinned: Map<MemoryId, boolean>,
): void {
  switch (event.kind) {
    case "memory:inserted":
    case "memory:updated":
      previousStatus.set(event.record.id, event.record.status);
      previousPinned.set(event.record.id, event.record.pinned);
      return;
    case "memory:deleted":
      previousStatus.delete(event.memoryId);
      previousPinned.delete(event.memoryId);
      return;
    case "memory:tombstoned":
      previousStatus.delete(event.tombstone.memoryId);
      previousPinned.delete(event.tombstone.memoryId);
      return;
    default:
      return;
  }
}

// ─── Direct emission helper ───────────────────────────────────────────────────
// Used by future retrieval (#210) and workflow (#213) wiring to emit
// `memory:retrieved` and `memory:workflow-used` directly, bypassing the vault bridge.
// Failures are swallowed and reported through the same channel as the bridge.

export interface RecordMemoryAuditOptions {
  readonly evidenceStore: EvidenceStore;
  readonly now?: () => number;
  readonly onPersistError?: (error: unknown) => void;
}

export function recordMemoryAudit(
  options: RecordMemoryAuditOptions,
  event: MemoryAuditEvent,
): void {
  const nowMs = (options.now ?? ((): number => Date.now()))();
  const onPersistError =
    options.onPersistError ??
    ((error: unknown): void => {
      // eslint-disable-next-line no-console
      console.error("memory-audit-handler: direct emission failed", error);
    });
  try {
    appendAuditEvent(options.evidenceStore, auditRunIdFor(nowMs), event);
  } catch (error) {
    onPersistError(error);
  }
}

// ─── No-op handler ────────────────────────────────────────────────────────────
// Used when no evidence store is configured (legacy tests, tooling). Keeps the
// `onMemoryEvent` port wired so the vault doesn't have to special-case undefined.

export function createNoopMemoryAuditHandler(): MemoryAuditHandler {
  return (): void => undefined;
}
