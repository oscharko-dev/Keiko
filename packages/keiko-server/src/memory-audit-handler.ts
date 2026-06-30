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
// Persistence shape: ONE manifest per UTC date. Stores that expose `EvidenceStore.update()`
// serialize the read-append-write step so concurrent audit appenders do not drop events.
// Custom stores without that optional method still work through get+put, but the built-in
// Node and in-memory stores use the safer update path.
//
// Failure mode: persistence errors are caught and logged to console.error; the handler
// never throws. An audit-persistence failure must NEVER break the user's memory mutation.
// Corrupt audit manifests are never reset or overwritten; append attempts fail closed and
// preserve the existing artifact for operator investigation.
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
// Retrieval/workflow-specific kinds are NOT vault-derived. The `recordMemoryAudit()`
// helper exported below is the single emission point for those direct audit signals.

import { createHash, randomUUID } from "node:crypto";
import type { MemoryAuditEvent, MemoryId, MemoryStatus } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { MemoryEvent } from "@oscharko-dev/keiko-memory-vault";
import {
  buildDeletedEvent,
  buildInsertedEvent,
  buildTombstonedEvent,
  buildUpdatedEvent,
  type BuildContext,
} from "./memory-audit-event-builders.js";
import { sanitizeAuditEvent } from "./memory-scope-sanitizer.js";

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
const AUDIT_HASH_CHAIN_VERSION = "sha256-v1";
const AUDIT_HASH_GENESIS = "0".repeat(64);

interface MemoryAuditIntegrity {
  readonly version: typeof AUDIT_HASH_CHAIN_VERSION;
  readonly previousHash: string;
  readonly eventHash: string;
  readonly sequence: number;
}

type PersistedMemoryAuditEvent = MemoryAuditEvent & {
  readonly integrity?: MemoryAuditIntegrity;
};

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

// Appends audit events to the date-bucketed manifest. The built-in evidence stores expose an
// atomic update path; fallback stores still get parse-safe get+put behavior. Batch callers should
// pass every event for one operation at once so the daily JSON manifest is parsed and rewritten once.
function appendAuditEvents(
  store: EvidenceStore,
  runId: string,
  events: readonly MemoryAuditEvent[],
): void {
  if (events.length === 0) {
    return;
  }
  const append = (existingJson: string | undefined): string =>
    JSON.stringify(appendIntegrity(parseExistingEvents(existingJson), events));

  if (store.update !== undefined) {
    store.update(runId, append);
    return;
  }

  store.put(runId, append(store.get(runId)));
}

function parseExistingEvents(json: string | undefined): PersistedMemoryAuditEvent[] {
  if (json === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error("memory audit manifest has unexpected shape");
    }
    return parsed as PersistedMemoryAuditEvent[];
  } catch (error) {
    throw new Error(
      `memory audit manifest is corrupt; refusing to overwrite existing audit evidence: ${
        error instanceof Error ? error.message : "unknown"
      }`,
      { cause: error },
    );
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type ParsedAuditIntegrity = Omit<MemoryAuditIntegrity, "version"> & {
  readonly version: string;
};

type ParsedPersistedMemoryAuditEvent = Omit<PersistedMemoryAuditEvent, "integrity"> & {
  readonly integrity?: ParsedAuditIntegrity;
};

function withoutIntegrity(event: ParsedPersistedMemoryAuditEvent): MemoryAuditEvent {
  const rest: Record<string, unknown> = { ...event };
  delete rest.integrity;
  return rest as unknown as MemoryAuditEvent;
}

function hashAuditEvent(event: MemoryAuditEvent, previousHash: string, sequence: number): string {
  return createHash("sha256")
    .update(stableStringify({ event, previousHash, sequence, version: AUDIT_HASH_CHAIN_VERSION }))
    .digest("hex");
}

function lastIntegrity(
  existing: readonly PersistedMemoryAuditEvent[],
): MemoryAuditIntegrity | undefined {
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    const integrity = existing[i]?.integrity;
    if (integrity !== undefined) return integrity;
  }
  return undefined;
}

function appendIntegrity(
  existing: readonly PersistedMemoryAuditEvent[],
  events: readonly MemoryAuditEvent[],
): readonly PersistedMemoryAuditEvent[] {
  const out: PersistedMemoryAuditEvent[] = [...existing];
  const last = lastIntegrity(existing);
  let previousHash = last?.eventHash ?? AUDIT_HASH_GENESIS;
  let sequence = last === undefined ? existing.length : last.sequence + 1;
  for (const event of events) {
    const eventHash = hashAuditEvent(event, previousHash, sequence);
    out.push({
      ...event,
      integrity: {
        version: AUDIT_HASH_CHAIN_VERSION,
        previousHash,
        eventHash,
        sequence,
      },
    });
    previousHash = eventHash;
    sequence += 1;
  }
  return out;
}

function parseAuditEvents(json: string): readonly ParsedPersistedMemoryAuditEvent[] | string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return "memory audit manifest is not an array";
    return parsed as readonly ParsedPersistedMemoryAuditEvent[];
  } catch (error) {
    return error instanceof Error ? error.message : "memory audit manifest is invalid JSON";
  }
}

function verifyEventIntegrity(
  event: ParsedPersistedMemoryAuditEvent,
  expectedPreviousHash: string,
  expectedSequence: number,
): string | null {
  const integrity = event.integrity;
  if (integrity === undefined) return "missing integrity metadata after hash chain started";
  if (integrity.version !== AUDIT_HASH_CHAIN_VERSION) {
    return "unsupported audit hash chain version";
  }
  if (integrity.previousHash !== expectedPreviousHash) {
    return "audit hash chain previousHash mismatch";
  }
  if (integrity.sequence !== expectedSequence) {
    return "audit hash chain sequence mismatch";
  }
  const actualHash = hashAuditEvent(withoutIntegrity(event), integrity.previousHash, integrity.sequence);
  return integrity.eventHash === actualHash ? null : "audit hash chain eventHash mismatch";
}

export function verifyMemoryAuditHashChain(
  json: string,
): { ok: true } | { ok: false; error: string } {
  const events = parseAuditEvents(json);
  if (typeof events === "string") return { ok: false, error: events };
  let expectedPreviousHash = AUDIT_HASH_GENESIS;
  let expectedSequence = 0;
  let sawIntegrity = false;
  for (const event of events) {
    if (event.integrity === undefined) {
      if (!sawIntegrity) {
        expectedSequence += 1;
        continue;
      }
      return { ok: false, error: "missing integrity metadata after hash chain started" };
    }
    const error = verifyEventIntegrity(event, expectedPreviousHash, expectedSequence);
    if (error !== null) return { ok: false, error };
    sawIntegrity = true;
    expectedPreviousHash = event.integrity.eventHash;
    expectedSequence += 1;
  }
  return { ok: true };
}

export function assertMemoryAuditWritable(store: EvidenceStore, nowMs: number): void {
  const runId = auditRunIdFor(nowMs);
  const keepExisting = (existingJson: string | undefined): string => {
    parseExistingEvents(existingJson);
    return existingJson ?? "[]";
  };
  if (store.update !== undefined) {
    store.update(runId, keepExisting);
    return;
  }
  store.put(runId, keepExisting(store.get(runId)));
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
  const previousStatus = new Map<MemoryId, MemoryStatus>();
  const previousPinned = new Map<MemoryId, boolean>();

  return (event: MemoryEvent): void => {
    const ctx: BuildContext = {
      occurredAt: now(),
      newEventId,
      redactString: options.redactString,
    };
    const auditEvent = mapVaultEvent(event, previousStatus, previousPinned, ctx);
    updateStateCache(event, previousStatus, previousPinned);
    if (auditEvent === undefined) {
      return;
    }
    try {
      appendAuditEvents(options.evidenceStore, auditRunIdFor(auditEvent.occurredAt), [
        sanitizeAuditEvent(auditEvent, options.redactString),
      ]);
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
      if (event.tombstoned) {
        return undefined;
      }
      return buildDeletedEvent(event.memoryId, event.scope, ctx);
    case "edge:inserted":
    case "edge:deleted":
    case "embedding:upserted":
      // Edge and embedding events are out of audit scope.
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
// Used by retrieval (#210) and workflow (#213) wiring to emit direct audit events,
// bypassing the vault bridge when no structural vault mutation exists.
// Failures are swallowed and reported through the same channel as the bridge.

export interface RecordMemoryAuditOptions {
  readonly evidenceStore: EvidenceStore;
  readonly now?: () => number;
  readonly redactString?: (input: string) => string;
  readonly onPersistError?: (error: unknown) => void;
}

export function recordMemoryAudit(
  options: RecordMemoryAuditOptions,
  event: MemoryAuditEvent,
): void {
  recordMemoryAudits(options, [event]);
}

export function recordMemoryAudits(
  options: RecordMemoryAuditOptions,
  events: readonly MemoryAuditEvent[],
): void {
  if (events.length === 0) {
    return;
  }
  const redactString = options.redactString ?? ((input: string): string => input);
  const onPersistError =
    options.onPersistError ??
    ((error: unknown): void => {
      // eslint-disable-next-line no-console
      console.error("memory-audit-handler: direct emission failed", error);
    });
  const eventsByRunId = new Map<string, MemoryAuditEvent[]>();
  for (const event of events) {
    const runId = auditRunIdFor(event.occurredAt);
    const bucket = eventsByRunId.get(runId);
    if (bucket === undefined) {
      eventsByRunId.set(runId, [sanitizeAuditEvent(event, redactString)]);
    } else {
      bucket.push(sanitizeAuditEvent(event, redactString));
    }
  }
  for (const [runId, bucket] of eventsByRunId) {
    try {
      appendAuditEvents(options.evidenceStore, runId, bucket);
    } catch (error) {
      onPersistError(error);
    }
  }
}

// ─── No-op handler ────────────────────────────────────────────────────────────
// Used when no evidence store is configured (legacy tests, tooling). Keeps the
// `onMemoryEvent` port wired so the vault doesn't have to special-case undefined.

export function createNoopMemoryAuditHandler(): MemoryAuditHandler {
  return (): void => undefined;
}
