// Forget / delete selection + envelope construction.
//
// Two pure functions:
//
//   selectMemoriesForForget — filters a caller-supplied MemoryRecord array down to the
//   subset matched by a ForgetSelector. Default `protectPinned: true` excludes pinned
//   memories (the user must explicitly unpin first). Default `protectArchived: false`
//   does NOT exclude archived memories (they are already out of active retrieval; a
//   retention sweep is allowed to re-select them).
//
//   buildForgetOperations — maps each selected MemoryRecord to a MemoryForget envelope.
//   The contracts type literally pins `userAcknowledgedDestructive` to the literal
//   `true`, so the envelope cannot structurally be constructed without acknowledgement.
//   Every envelope is revalidated through validateMemoryForget before returning.
//
// The two-stage shape is deliberate: callers can present the selection to the user for
// confirmation (Memory Center UI #211) before materialising the destructive envelopes.

import type { MemoryForget, MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import { validateMemoryForget } from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import type {
  BuildForgetOperationsOptions,
  ForgetSelector,
  GovernanceContext,
  SelectMemoriesForForgetOptions,
} from "./types.js";

// ─── Scope coordinate equality ────────────────────────────────────────────────
// Pure: two scopes match when their discriminator AND coordinate field match exactly.
// Implemented via a canonical "kind:coordinate" string projection to collapse the
// per-kind branching (memory pattern from issue #205 scopeCoordinateKey).
function scopeCoordinateKey(scope: MemoryScope): string {
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
    default: {
      const _exhaustive: never = scope;
      void _exhaustive;
      return "unknown:";
    }
  }
}

function scopeEquals(a: MemoryScope, b: MemoryScope): boolean {
  return scopeCoordinateKey(a) === scopeCoordinateKey(b);
}

// ─── Per-selector filter predicates ───────────────────────────────────────────
function matchById(
  record: MemoryRecord,
  selector: Extract<ForgetSelector, { kind: "by-id" }>,
): boolean {
  return record.id === selector.memoryId;
}

function matchByScope(
  record: MemoryRecord,
  selector: Extract<ForgetSelector, { kind: "by-scope" }>,
): boolean {
  return scopeEquals(record.scope, selector.scope);
}

function matchByType(
  record: MemoryRecord,
  selector: Extract<ForgetSelector, { kind: "by-type" }>,
): boolean {
  return scopeEquals(record.scope, selector.scope) && record.type === selector.type;
}

function matchBySourceConversation(
  record: MemoryRecord,
  selector: Extract<ForgetSelector, { kind: "by-source-conversation" }>,
): boolean {
  if (!scopeEquals(record.scope, selector.scope)) return false;
  return record.provenance.sourceConversationId === selector.sourceConversationId;
}

function matchByTimeWindow(
  record: MemoryRecord,
  selector: Extract<ForgetSelector, { kind: "by-time-window" }>,
  nowMs: number,
): boolean {
  if (!scopeEquals(record.scope, selector.scope)) return false;
  return record.createdAt <= nowMs - selector.olderThanMs;
}

function assertSelectorWellFormed(selector: ForgetSelector): void {
  if (selector.kind === "by-time-window") {
    if (!Number.isFinite(selector.olderThanMs) || selector.olderThanMs < 0) {
      throw new GovernanceError(
        "invalid-selector-input",
        "by-time-window olderThanMs must be a finite non-negative number",
      );
    }
  }
}

function applySelector(record: MemoryRecord, selector: ForgetSelector, nowMs: number): boolean {
  switch (selector.kind) {
    case "by-id":
      return matchById(record, selector);
    case "by-scope":
      return matchByScope(record, selector);
    case "by-type":
      return matchByType(record, selector);
    case "by-source-conversation":
      return matchBySourceConversation(record, selector);
    case "by-time-window":
      return matchByTimeWindow(record, selector, nowMs);
    default: {
      // Exhaustiveness gate: a future widening of ForgetSelector surfaces here at
      // compile time and at runtime as an unsupported-selector error.
      const _exhaustive: never = selector;
      void _exhaustive;
      throw new GovernanceError("unsupported-selector", "unknown ForgetSelector kind");
    }
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────
export function selectMemoriesForForget(
  memories: readonly MemoryRecord[],
  selector: ForgetSelector,
  options: SelectMemoriesForForgetOptions,
): readonly MemoryRecord[] {
  assertSelectorWellFormed(selector);
  const protectPinned = options.protectPinned ?? true;
  const protectArchived = options.protectArchived ?? false;
  const selected: MemoryRecord[] = [];
  for (const record of memories) {
    if (protectPinned && record.pinned) continue;
    if (protectArchived && record.status === "archived") continue;
    if (record.status === "forgotten") continue;
    if (!applySelector(record, selector, options.nowMs)) continue;
    selected.push(record);
  }
  return selected;
}

// ─── Envelope construction ────────────────────────────────────────────────────
const DEFAULT_FORGET_REASON = "user-requested forget";

function buildForgetEnvelope(
  record: MemoryRecord,
  context: GovernanceContext,
  options: BuildForgetOperationsOptions,
): MemoryForget {
  const env: MemoryForget = {
    schemaVersion: "1",
    memoryId: record.id,
    reviewerId: context.reviewerId,
    forgottenAt: context.nowMs,
    reason: options.reason ?? DEFAULT_FORGET_REASON,
    userAcknowledgedDestructive: true,
  };
  const v = validateMemoryForget(env);
  if (!v.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      `forget envelope failed contracts validation for memory ${record.id}`,
      v.errors,
    );
  }
  return env;
}

export function buildForgetOperations(
  memories: readonly MemoryRecord[],
  context: GovernanceContext,
  options: BuildForgetOperationsOptions,
): readonly MemoryForget[] {
  // `writeTombstone` is currently observed only at the storage seam (vault #206 writes
  // an audit tombstone unconditionally). The flag remains on the option bundle as a
  // future-extension surface and as a forcing function for caller intent — the BFF
  // route handler MUST decide consciously whether the destructive operation is
  // tombstone-yielding.
  void options.writeTombstone;
  const envelopes: MemoryForget[] = [];
  for (const record of memories) {
    envelopes.push(buildForgetEnvelope(record, context, options));
  }
  return envelopes;
}
