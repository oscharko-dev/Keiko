import { CLIENT_STAGE_DURATION_MS_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "./bff-correlation";
import { reportClientDiagnostic } from "./client-diagnostics";

interface MemoryVaultViewChange {
  readonly kind: "updated" | "removed";
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

export function notifyMemoryVaultViewChange(change: MemoryVaultViewChange): void {
  if (listeners.size === 0 || change.ids.length === 0) return;
  const correlationId = newClientCorrelationId();
  const stage = "memory vault view change";
  reportClientDiagnostic("Memory vault view change started.", {
    correlationId,
    stageReport: { stage, phase: "started", ordinal: 1 },
  });
  const startedAt = performance.now();
  let notificationFailed = false;
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      notificationFailed = true;
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
  if (notificationFailed) {
    reportClientDiagnostic("Memory vault view notification failed.", {
      correlationId,
      kind: "other",
      failureStage: stage,
    });
  }
}
