import {
  CLIENT_STAGE_DURATION_MS_MAX,
  type ClientNavigationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

/** Selection lifecycle only: no pod names, source paths or document contents. */
export function beginPodSelectionEvidence(): (outcome: ClientNavigationOutcome) => void {
  const correlationId = newClientCorrelationId();
  const startedAt = performance.now();
  let settled = false;
  // i18n-exempt: body-free Activity Log evidence, never rendered.
  reportClientDiagnostic("Knowledge Pod selection started.", {
    correlationId,
    stageReport: { stage: "knowledge pod selection", phase: "started", ordinal: 1 },
  });
  return (navigationOutcome): void => {
    if (settled) return;
    settled = true;
    const durationMs = Math.min(
      CLIENT_STAGE_DURATION_MS_MAX,
      Math.max(0, Math.round(performance.now() - startedAt)),
    );
    // i18n-exempt: body-free Activity Log evidence, never rendered.
    reportClientDiagnostic("Knowledge Pod selection settled.", {
      correlationId,
      stageReport: {
        stage: "knowledge pod selection",
        phase: "settled",
        ordinal: 1,
        durationMs,
        navigationOutcome,
      },
    });
  };
}
