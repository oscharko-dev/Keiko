import type { ConversationMemoryResultWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CLIENT_STAGE_DURATION_MS_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "./bff-correlation";
import { reportClientDiagnostic } from "./client-diagnostics";

interface MemoryVaultViewChange {
  readonly kind: "updated" | "edited" | "removed";
  readonly ids: readonly string[];
}

type Listener = (change: MemoryVaultViewChange) => void;
const listeners = new Set<Listener>();

export function subscribeMemoryVaultViewChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A live turn may have already committed a Forget on the server. Historical Chat messages
// carry the same action wire for display but do not publish a new Vault change.
export function notifyCompletedChatForgets(memory: ConversationMemoryResultWire | undefined): void {
  const removed = new Set<string>();
  for (const action of memory?.actions ?? []) {
    if (action.kind === "forget" && action.forgotten === true && !action.requiresConfirmation) {
      removed.add(action.memoryId);
    }
  }
  notifyMemoryVaultViewChange({ kind: "removed", ids: [...removed] });
}

export function notifyMemoryVaultViewChange(change: MemoryVaultViewChange): void {
  if (listeners.size === 0 || change.ids.length === 0) return;
  const correlationId = newClientCorrelationId();
  const stage = "memory vault view change";
  reportClientDiagnostic("Memory vault view change started.", {
    correlationId,
    stageReport: { stage, phase: "started", ordinal: 1 },
  });
  const startedAt = performance.now();
  let failureReported = false;
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      if (!failureReported) {
        reportClientDiagnostic("Memory vault view notification failed.", {
          correlationId,
          kind: "other",
          failureStage: stage,
        });
        failureReported = true;
      }
    }
  }
  const durationMs = Math.min(
    CLIENT_STAGE_DURATION_MS_MAX,
    Math.max(0, Math.round(performance.now() - startedAt)),
  );
  reportClientDiagnostic("Memory vault view change settled.", {
    correlationId,
    stageReport: { stage, phase: "settled", ordinal: 1, durationMs },
  });
}
