// Content-free lifecycle evidence for managed task workspaces (Issue #445, Epic #443).
//
// Each provision / activate / block / fail / retry-required outcome writes ONE evidence document
// through the shared EvidenceStore.put port, redacted via the same deepRedactStrings defense-in-depth
// as the command-runner and memory-audit ledgers. The payload is a #444 `WorkspaceEvent` — validated
// here against the contract's closed allowlist so a smuggled source/secret field is rejected before
// persistence (SC3) — plus counts/enums only (operation, outcome, duration, attempt, worktree count).
// It carries NO repository root, NO worktree path, NO branch name, NO command output.
//
// `EvidenceTaskType` is a closed union, so this is NOT an EvidenceManifest: it is a self-describing
// content-free document keyed by the event id, exactly like the memory-audit ledger entries.

import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  validateWorkspaceEvent,
  type TaskWorkspaceDriftMarker,
  type TaskWorkspaceHealth,
  type TaskWorkspaceLifecycleState,
  type WorkspaceEvent,
  type WorkspaceEventType,
} from "@oscharko-dev/keiko-contracts";

export const WORKSPACE_LIFECYCLE_EVIDENCE_KIND = "task-workspace-lifecycle" as const;

export type WorkspaceLifecycleOperation = "provision" | "activate";

export type WorkspaceLifecycleOutcome =
  | "provisioned"
  | "activated"
  | "resumed"
  | "blocked"
  | "failed"
  | "retry-required";

export interface WorkspaceLifecycleEvidenceRecord {
  readonly kind: typeof WORKSPACE_LIFECYCLE_EVIDENCE_KIND;
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly recordedAt: number;
  readonly operation: WorkspaceLifecycleOperation;
  readonly outcome: WorkspaceLifecycleOutcome;
  readonly attempt: number;
  readonly durationMs: number;
  readonly worktreeCount: number;
  readonly event: WorkspaceEvent;
}

export interface BuildWorkspaceEventInput {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly type: WorkspaceEventType;
  readonly at: string;
  readonly correlationId: string;
  readonly fromState?: TaskWorkspaceLifecycleState | undefined;
  readonly toState?: TaskWorkspaceLifecycleState | undefined;
  readonly health?: TaskWorkspaceHealth | undefined;
  readonly driftMarkers?: readonly TaskWorkspaceDriftMarker[] | undefined;
  readonly lockId?: string | undefined;
}

// Assembles and VALIDATES a content-free WorkspaceEvent. The validation is defense in depth: with the
// typed inputs above the event is always well-formed, but routing it through the contract validator
// guarantees no caller can ever persist a non-content-free shape through this path (SC3). Throws on a
// validation failure rather than persisting a malformed audit record.
export function buildWorkspaceEvent(input: BuildWorkspaceEventInput): WorkspaceEvent {
  const event: WorkspaceEvent = {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    type: input.type,
    at: input.at,
    correlationId: input.correlationId,
    ...(input.fromState !== undefined ? { fromState: input.fromState } : {}),
    ...(input.toState !== undefined ? { toState: input.toState } : {}),
    ...(input.health !== undefined ? { health: input.health } : {}),
    ...(input.driftMarkers !== undefined ? { driftMarkers: input.driftMarkers } : {}),
    ...(input.lockId !== undefined ? { lockId: input.lockId } : {}),
  };
  const validation = validateWorkspaceEvent(event);
  if (!validation.ok) {
    throw new Error(
      `content-free workspace event invariant violated: ${validation.reasons.join("; ")}`,
    );
  }
  return event;
}

// Persists ONE lifecycle evidence document, redacting every string leaf first. Best-effort by
// construction: an evidence-store error must never corrupt the real provisioning result, so it is
// swallowed and reported as `undefined` (mirrors the command-runner evidence write). Returns the
// stored location on success.
export function appendWorkspaceLifecycleEvidence(
  store: EvidenceStore,
  record: WorkspaceLifecycleEvidenceRecord,
  redact: (input: string) => string,
): string | undefined {
  try {
    const safe = deepRedactStrings(record, redact) as WorkspaceLifecycleEvidenceRecord;
    return store.put(safe.event.eventId, JSON.stringify(safe, null, 2));
  } catch {
    return undefined;
  }
}
