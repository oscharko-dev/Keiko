// Memory diagnostics export (Epic #204, Issue #214).
//
// Builds a body-free snapshot of the local memory state suitable for support / debugging
// without exfiltrating any user content. The snapshot carries:
//
//   - generatedAt           epoch ms when the snapshot was built
//   - scopeCounts           total record count per requested scope (post-redaction key)
//   - statusHistogram       record count per MemoryStatus across all scanned scopes
//   - recentAuditEvents     last N audit events (already redacted at persist time)
//   - storagePath           the configured evidence dir, run through redactString
//
// Hard invariants:
//
//   - The raw record body is NEVER serialised. There is no opt-in flag in this PR.
//   - The raw payload is NEVER serialised either. The same rationale.
//   - The storage path is run through the audit redactor in case a user-supplied path
//     happens to contain a credential-shaped segment.
//   - Audit event tail is sanitised again on export. Persist-time redaction remains the
//     primary boundary, but diagnostics must stay non-leaking even if a local manifest is
//     edited or produced by an older writer.
//
// This function does NOT mutate the vault. It only reads.

import type { MemoryAuditEvent, MemoryScope, MemoryStatus } from "@oscharko-dev/keiko-contracts";
import { MEMORY_STATUSES } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { auditRunIdFor } from "./memory-audit-handler.js";
import {
  auditEventTouchesScope,
  memoryScopeKey,
  sanitizeAuditEvent,
  sanitizeMemoryScope,
} from "./memory-scope-sanitizer.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MemoryScopeCount {
  // The scope as reported back to the caller. Identical to the requested scope; we keep
  // it on the return value so a downstream renderer does not need to re-pair indices.
  readonly scope: MemoryScope;
  readonly count: number;
}

export type MemoryStatusHistogram = Readonly<Record<MemoryStatus, number>>;

export interface MemoryDiagnostics {
  readonly schemaVersion: "1";
  readonly generatedAt: number;
  readonly scopeCounts: readonly MemoryScopeCount[];
  readonly statusHistogram: MemoryStatusHistogram;
  readonly recentAuditEvents: readonly MemoryAuditEvent[];
  readonly storagePath: string;
}

export interface ExportMemoryDiagnosticsOptions {
  readonly vault: MemoryVaultStore;
  readonly scopes: readonly MemoryScope[];
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (input: string) => string;
  // The configured evidence dir. Redacted into `storagePath` so a custom path with a
  // sensitive segment (rare but possible) is not leaked.
  readonly evidenceDir: string;
  // Cap on the number of audit events returned. Defaults to 50; clamped to [1, 1000].
  readonly lastNAuditEvents?: number;
  // Optional clock; defaults to Date.now. Tests inject for determinism.
  readonly now?: () => number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_AUDIT_EVENT_TAIL = 50;
const MIN_AUDIT_EVENT_TAIL = 1;
const MAX_AUDIT_EVENT_TAIL = 1000;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function emptyHistogram(): Record<MemoryStatus, number> {
  const counts: Record<MemoryStatus, number> = {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
    archived: 0,
    forgotten: 0,
    conflicted: 0,
    expired: 0,
  };
  return counts;
}

function clampTail(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_AUDIT_EVENT_TAIL;
  }
  const integer = Math.floor(value);
  if (integer < MIN_AUDIT_EVENT_TAIL) {
    return MIN_AUDIT_EVENT_TAIL;
  }
  if (integer > MAX_AUDIT_EVENT_TAIL) {
    return MAX_AUDIT_EVENT_TAIL;
  }
  return integer;
}

// Pulls the most recent N audit events from today's manifest and (if today's is short)
// continues into yesterday's manifest. Two-day window is deliberate: a longer window
// would risk scanning the entire ledger; the diagnostics view exists for a "what just
// happened?" support snapshot, not a full audit replay.
function readRecentAuditEvents(
  store: EvidenceStore,
  nowMs: number,
  limit: number,
  allowedScopeKeys: ReadonlySet<string>,
  redactString: (input: string) => string,
): readonly MemoryAuditEvent[] {
  const today = readAuditManifest(store, auditRunIdFor(nowMs))
    .map((event) => sanitizeAuditEvent(event, redactString))
    .filter((event) => auditEventTouchesScope(event, allowedScopeKeys));
  if (today.length >= limit) {
    return today.slice(today.length - limit);
  }
  const yesterday = readAuditManifest(store, auditRunIdFor(nowMs - 24 * 60 * 60 * 1000))
    .map((event) => sanitizeAuditEvent(event, redactString))
    .filter((event) => auditEventTouchesScope(event, allowedScopeKeys));
  const combined = [...yesterday, ...today];
  if (combined.length <= limit) {
    return combined;
  }
  return combined.slice(combined.length - limit);
}

function readAuditManifest(store: EvidenceStore, runId: string): readonly MemoryAuditEvent[] {
  const json = store.get(runId);
  if (json === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed as MemoryAuditEvent[];
    }
    return [];
  } catch {
    return [];
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function exportMemoryDiagnostics(
  options: ExportMemoryDiagnosticsOptions,
): MemoryDiagnostics {
  const now = options.now ?? ((): number => Date.now());
  const nowMs = now();
  const histogram = emptyHistogram();
  const sanitizedScopes = options.scopes.map((scope) =>
    sanitizeMemoryScope(scope, options.redactString),
  );
  const allowedScopeKeys = new Set(sanitizedScopes.map((scope) => memoryScopeKey(scope)));
  const scopeCounts = options.scopes.map((scope, index) => {
    const records = options.vault.listMemoriesByScope(scope, { includeExpired: true });
    for (const record of records) {
      histogram[record.status] += 1;
    }
    return {
      scope: sanitizedScopes[index] ?? sanitizeMemoryScope(scope, options.redactString),
      count: records.length,
    };
  });
  const tail = clampTail(options.lastNAuditEvents);
  const recentAuditEvents = readRecentAuditEvents(
    options.evidenceStore,
    nowMs,
    tail,
    allowedScopeKeys,
    options.redactString,
  );
  return {
    schemaVersion: "1",
    generatedAt: nowMs,
    scopeCounts,
    statusHistogram: histogram,
    recentAuditEvents,
    storagePath: options.redactString(options.evidenceDir),
  };
}

// Re-export the status list for callers that want to render a stable histogram order.
export { MEMORY_STATUSES };
