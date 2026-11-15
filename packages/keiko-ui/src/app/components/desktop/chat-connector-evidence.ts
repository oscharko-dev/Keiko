import {
  CLIENT_STAGE_DURATION_MS_MAX,
  type ClientNavigationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

/** No Chat identity, mode, connector name or content leaves the browser. */
export function beginChatConnectorEvidence(
  stage: "chat connector selection" | "chat connector refresh",
): { correlationId: string; settle: (outcome: ClientNavigationOutcome) => void } {
  const correlationId = newClientCorrelationId();
  const startedAt = performance.now();
  let settled = false;
  // i18n-exempt: body-free Activity Log evidence, never rendered.
  reportClientDiagnostic("Chat connector operation started.", {
    correlationId,
    stageReport: { stage, phase: "started", ordinal: 1 },
  });
  return {
    correlationId,
    settle(navigationOutcome): void {
      if (settled) return;
      settled = true;
      const durationMs = Math.min(
        CLIENT_STAGE_DURATION_MS_MAX,
        Math.max(0, Math.round(performance.now() - startedAt)),
      );
      // i18n-exempt: body-free Activity Log evidence, never rendered.
      reportClientDiagnostic("Chat connector operation settled.", {
        correlationId,
        stageReport: { stage, phase: "settled", ordinal: 1, durationMs, navigationOutcome },
      });
    },
  };
}
