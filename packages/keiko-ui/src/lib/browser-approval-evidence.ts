import {
  CLIENT_STAGE_DURATION_MS_MAX,
  type ClientBrowserApprovalEvidence,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "./bff-correlation";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorSummary } from "./client-error-summary";
import { bffRequestErrorKind } from "./http";

type Outcome = NonNullable<ClientBrowserApprovalEvidence["outcome"]>;

function reportStage(
  operation: ClientBrowserApprovalEvidence["operation"],
  correlationId: string,
  settlement?: { readonly outcome: Outcome; readonly durationMs: number },
  parentCorrelationId?: string,
): void {
  const common = { stage: "browser approval", ordinal: 1 } as const;
  reportClientDiagnostic("Browser approval operation.", {
    correlationId,
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
    stageReport:
      settlement === undefined
        ? { ...common, phase: "started", browserApproval: { operation } }
        : {
            ...common,
            phase: "settled",
            durationMs: settlement.durationMs,
            browserApproval: { operation, outcome: settlement.outcome },
          },
  });
}

/** Only closed outcomes cross this port; the operation's key/record value never does. */
export async function observeBrowserApproval<T>(
  operation: ClientBrowserApprovalEvidence["operation"],
  task: (correlationId: string) => Promise<{ readonly value: T; readonly outcome: Outcome }>,
  parentCorrelationId?: string,
): Promise<T> {
  const correlationId = newClientCorrelationId();
  const startedAt = performance.now();
  let outcome: Outcome = "failed";
  reportStage(operation, correlationId, undefined, parentCorrelationId);
  try {
    const result = await task(correlationId);
    outcome = result.outcome;
    return result.value;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") outcome = "cancelled";
    reportClientDiagnostic(`Browser approval operation failed: ${clientErrorSummary(error)}`, {
      correlationId,
      ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
      errorKind: bffRequestErrorKind(error),
    });
    throw error;
  } finally {
    const durationMs = Math.min(
      CLIENT_STAGE_DURATION_MS_MAX,
      Math.max(0, Math.round(performance.now() - startedAt)),
    );
    reportStage(operation, correlationId, { durationMs, outcome }, parentCorrelationId);
  }
}
