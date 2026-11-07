import { randomUUID } from "node:crypto";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryCaptureSurfaceWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  MemoryRecord,
  MemoryScope,
  MemorySourceKind,
} from "@oscharko-dev/keiko-contracts/memory";
import type { RejectionReason } from "@oscharko-dev/keiko-memory-capture";
import { currentAuditRedactString, type UiHandlerDeps } from "./deps.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { buildMemoryCaptureDecisionAuditEvent } from "./memory-capture-projection.js";

function auditSurface(
  surface: ConversationMemoryCaptureSurfaceWire,
): "conversation-center" | "voice" {
  return surface === "voice" ? "voice" : "conversation-center";
}

export function recordAutoAcceptedMemoryCaptureDecision(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  surface: ConversationMemoryCaptureSurfaceWire,
  memory: MemoryRecord,
): void {
  recordMemoryAudit(
    {
      evidenceStore: deps.evidenceStore,
      redactString: currentAuditRedactString(deps),
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
    },
    buildMemoryCaptureDecisionAuditEvent({
      eventId: randomUUID(),
      occurredAt: memory.updatedAt,
      outcome: "auto-accepted",
      scope: memory.scope,
      mode,
      initiatorSurface: auditSurface(surface),
      sourceKind: memory.provenance.sourceKind,
      reason: "governance-auto-accepted",
      memoryId: memory.id,
    }),
  );
}

// The private scope a person's own statement belongs to, where the Journal shows what Keiko refused
// to keep from it. A statement names no team, so a project scope would hide the refusal.
function statementScope(scopes: readonly MemoryScope[]): MemoryScope | undefined {
  return scopes.find((scope) => scope.kind === "user") ?? scopes[0];
}

// What a person reads in the Journal when Keiko refused to keep something they said: a credential,
// confidential content, a protected topic or an instruction (#4206). Bookkeeping refusals, such as
// an empty or over-long text or an ambiguous target, decide nothing about the person's privacy and
// would bury the refusals that do.
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
]);

export function isJournaledRefusalReason(reason: RejectionReason): boolean {
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
): void {
  const scope = statementScope(refusal.scopes);
  if (scope === undefined) return;
  recordMemoryAudit(
    {
      evidenceStore: deps.evidenceStore,
      redactString: currentAuditRedactString(deps),
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
    },
    buildMemoryCaptureDecisionAuditEvent({
      eventId: randomUUID(),
      occurredAt: Date.now(),
      outcome: "rejected",
      scope,
      mode: refusal.mode,
      initiatorSurface: auditSurface(refusal.surface),
      sourceKind: refusal.sourceKind,
      reason: refusal.reason,
    }),
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
): void {
  recordRefusedCaptureDecision(deps, {
    mode,
    surface,
    scopes,
    sourceKind: "explicit-user-instruction",
    reason,
  });
}
