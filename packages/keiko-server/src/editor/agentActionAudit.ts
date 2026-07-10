// Issue #1395, ADR-0062 — bounded, content-free audit ledger for agent editor actions.
//
// A per-session, append-only, FIFO-evicted in-memory ledger surfaces "recent agent editor actions"
// to the BFF read route and the UI. It is intentionally ephemeral (not persisted to disk): the issue
// excludes long-term telemetry collection. The record shape is content-free by construction (the
// contract builder is handed only enums, counts, identifiers, and a workspace-relative path) and is
// run through the keiko-security redactor (defense in depth) before it is stored or served, so raw
// source text and secrets cannot reach the ledger.

import {
  buildEditorAgentActionAuditRecord,
  isMutatingEditorAgentAction,
  type EditorAgentActionAuditRecord,
  type EditorAgentActionPolicyDecision,
  type EditorAgentActionStatus,
  type EditorAgentActionType,
  type EditorAgentConflictCode,
  type EditorAgentFailureCode,
} from "@oscharko-dev/keiko-contracts";
import { deepRedactStrings, redact } from "@oscharko-dev/keiko-security";

// Bounded like the route-edge idempotency map: a long-lived server cannot grow this without limit.
const MAX_RECORDS_PER_SESSION = 100;
const MAX_SESSIONS = 256;

export interface EditorAgentAuditInput {
  readonly occurredAt: number;
  readonly sessionId: string;
  readonly actionId: string;
  readonly actionType: EditorAgentActionType;
  readonly decision: EditorAgentActionPolicyDecision;
  readonly outcome: EditorAgentActionStatus;
  readonly conflictCode?: EditorAgentConflictCode | undefined;
  readonly failureCode?: EditorAgentFailureCode | undefined;
  readonly targetPath?: string | null | undefined;
  readonly editCount?: number | undefined;
  readonly patchByteLength?: number | undefined;
}

interface AuditLedgerState {
  readonly bySession: Map<string, EditorAgentActionAuditRecord[]>;
  seq: number;
}

const state: AuditLedgerState = { bySession: new Map(), seq: 0 };

// Defense in depth: re-redact every string leaf of the already-content-free record so a secret-shaped
// substring that slipped into a workspace-relative path or summary is scrubbed before storage.
function redactRecord(record: EditorAgentActionAuditRecord): EditorAgentActionAuditRecord {
  return deepRedactStrings(record, redact) as EditorAgentActionAuditRecord;
}

function appendRecord(sessionId: string, record: EditorAgentActionAuditRecord): void {
  const existing = state.bySession.get(sessionId) ?? [];
  const next = [...existing, record];
  if (next.length > MAX_RECORDS_PER_SESSION) {
    next.splice(0, next.length - MAX_RECORDS_PER_SESSION);
  }
  state.bySession.set(sessionId, next);
  while (state.bySession.size > MAX_SESSIONS) {
    const oldest = state.bySession.keys().next().value;
    if (oldest === undefined) break;
    state.bySession.delete(oldest);
  }
}

// Record one content-free audit entry for an agent editor action. Best-effort and throw-free: a
// ledger failure must never break the action path. AC1: every mutating action is audited. A denied
// action is audited even if it is not mutating, so a blocked attempt stays visible. Agent-triggered
// EXECUTION actions (Issue #2214: a governed verification run) are audited when admitted too — they are
// non-mutating but governance-relevant (they consume the sandboxed execution boundary and the
// Authority Envelope budget). Allowed navigation/layout actions remain unrecorded — the ledger is for
// governance-relevant activity. Returns the stored (redacted) record, or null when not audited/failed.
export function recordEditorAgentActionAudit(
  input: EditorAgentAuditInput,
): EditorAgentActionAuditRecord | null {
  if (
    !isMutatingEditorAgentAction(input.actionType) &&
    input.decision.effectClass !== "execution" &&
    input.decision.disposition !== "denied"
  ) {
    return null;
  }
  try {
    state.seq += 1;
    const record = buildEditorAgentActionAuditRecord({
      auditId: `editor-agent-audit-${String(state.seq)}`,
      occurredAt: input.occurredAt,
      sessionId: input.sessionId,
      actionId: input.actionId,
      actionType: input.actionType,
      decision: input.decision,
      outcome: input.outcome,
      conflictCode: input.conflictCode,
      failureCode: input.failureCode,
      targetPath: input.targetPath,
      editCount: input.editCount,
      patchByteLength: input.patchByteLength,
    });
    const redacted = redactRecord(record);
    appendRecord(input.sessionId, redacted);
    return redacted;
  } catch {
    return null;
  }
}

// Recent records, newest last. With a sessionId, returns that session's bounded list; without one,
// returns a bounded flattened view across sessions (the global observer's recent-activity feed).
export function listEditorAgentActionAudit(
  sessionId?: string,
): readonly EditorAgentActionAuditRecord[] {
  if (sessionId !== undefined) return state.bySession.get(sessionId) ?? [];
  const all: EditorAgentActionAuditRecord[] = [];
  for (const records of state.bySession.values()) all.push(...records);
  return all.slice(-MAX_RECORDS_PER_SESSION);
}

export function _resetEditorAgentAuditForTests(): void {
  state.bySession.clear();
  state.seq = 0;
}
