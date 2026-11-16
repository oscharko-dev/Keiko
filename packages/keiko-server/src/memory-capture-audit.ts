import { randomUUID } from "node:crypto";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryCaptureSurfaceWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemorySourceKind,
} from "@oscharko-dev/keiko-contracts/memory";
import type { RejectionReason } from "@oscharko-dev/keiko-memory-capture";
import { currentAuditRedactString, type UiHandlerDeps } from "./deps.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { logMemoryCaptureDecision } from "./memory-capture-decision-log.js";
import {
  buildMemoryCaptureDecisionAuditEvent,
  type MemoryCaptureDecisionOutcome,
  type MemoryCaptureDecisionReason,
} from "./memory-capture-projection.js";

function auditSurface(
  surface: ConversationMemoryCaptureSurfaceWire,
): "conversation-center" | "voice" {
  return surface === "voice" ? "voice" : "conversation-center";
}

/** One capture decision as the Journal and the Activity Log both record it (#4206). */
export interface MemoryCaptureDecisionInput {
  readonly mode: CodingWorkbenchMode;
  readonly surface: ConversationMemoryCaptureSurfaceWire;
  readonly outcome: MemoryCaptureDecisionOutcome;
  readonly scope: MemoryScope;
  readonly sourceKind: MemorySourceKind;
  readonly reason: Exclude<MemoryCaptureDecisionReason, "forgotten-by-person">;
  readonly occurredAt: number;
  readonly memoryId?: MemoryId;
}

// The one writer of a capture decision: the body-free audit event the Journal projects and the
// registered Activity Log line, under the correlation of the turn or request that decided it.
export function recordMemoryCaptureDecision(
  deps: UiHandlerDeps,
  decision: MemoryCaptureDecisionInput,
  correlationId: string,
): void {
  const { mode, surface, ...evidence } = decision;
  recordMemoryAudit(
    {
      evidenceStore: deps.evidenceStore,
      redactString: currentAuditRedactString(deps),
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
    },
    buildMemoryCaptureDecisionAuditEvent({
      eventId: randomUUID(),
      mode,
      initiatorSurface: auditSurface(surface),
      ...evidence,
    }),
  );
  logMemoryCaptureDecision(
    {
      outcome: decision.outcome,
      reason: decision.reason,
      mode,
      surface: auditSurface(surface),
      scopeKind: decision.scope.kind,
      sourceKind: decision.sourceKind,
    },
    correlationId,
  );
}

export function recordAutoAcceptedMemoryCaptureDecision(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  surface: ConversationMemoryCaptureSurfaceWire,
  memory: MemoryRecord,
  correlationId: string,
): void {
  recordMemoryCaptureDecision(
    deps,
    {
      mode,
      surface,
      outcome: "auto-accepted",
      scope: memory.scope,
      sourceKind: memory.provenance.sourceKind,
      reason: "governance-auto-accepted",
      occurredAt: memory.updatedAt,
      memoryId: memory.id,
    },
    correlationId,
  );
}

// The private scope a person's own statement belongs to, where the Journal shows what Keiko refused
// to keep from it. A statement names no team, so a project scope would hide the refusal.
function statementScope(scopes: readonly MemoryScope[]): MemoryScope | undefined {
  return scopes.find((scope) => scope.kind === "user") ?? scopes[0];
}

// What a person reads in the Journal when Keiko refused to keep something they said: a credential,
// confidential content, a protected topic, an instruction, or something they forgot or rejected
// before (#4206). Bookkeeping refusals, such as an empty or over-long text, an ambiguous target or
// an unresolvable scope, decide nothing about what Keiko keeps and would bury the refusals that do.
const JOURNALED_REFUSAL_REASONS: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  "credential-shape",
  "private-credential-path",
  "provider-base-url",
  "raw-log-content",
  "customer-identifier",
  "denied-category",
  "instruction-override",
  "restricted-sensitivity",
  "sensitive-memory-requires-approval",
  "suppressed-by-forget",
  "suppressed-by-rejection",
]);

function isJournaledRefusalReason(reason: RejectionReason): boolean {
  return JOURNALED_REFUSAL_REASONS.has(reason);
}

export interface RefusedCaptureDecision {
  readonly mode: CodingWorkbenchMode;
  readonly surface: ConversationMemoryCaptureSurfaceWire;
  readonly scopes: readonly MemoryScope[];
  readonly sourceKind: MemorySourceKind;
  readonly reason: RejectionReason;
}

// A refusal is shown body-free in the person's own scope. Without a scope to show it in there is
// nothing to record.
export function recordRefusedCaptureDecision(
  deps: UiHandlerDeps,
  refusal: RefusedCaptureDecision,
  correlationId: string,
): void {
  if (!isJournaledRefusalReason(refusal.reason)) return;
  const scope = statementScope(refusal.scopes);
  if (scope === undefined) return;
  recordMemoryCaptureDecision(
    deps,
    {
      mode: refusal.mode,
      surface: refusal.surface,
      outcome: "rejected",
      scope,
      sourceKind: refusal.sourceKind,
      reason: refusal.reason,
      occurredAt: Date.now(),
    },
    correlationId,
  );
}

// A person's own "Merke dir" that Keiko refused (a credential, confidential content) is a decision
// the Journal shows, body-free (#4206).
export function recordRefusedStatementCaptureDecision(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  surface: ConversationMemoryCaptureSurfaceWire,
  scopes: readonly MemoryScope[],
  reason: RejectionReason,
  correlationId: string,
): void {
  recordRefusedCaptureDecision(
    deps,
    { mode, surface, scopes, sourceKind: "explicit-user-instruction", reason },
    correlationId,
  );
}
