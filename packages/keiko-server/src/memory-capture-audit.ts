import { randomUUID } from "node:crypto";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryCaptureSurfaceWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
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
