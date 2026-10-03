import type { ClientStageId } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { CLIENT_STAGE_DURATION_MS_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId, responseCorrelationIdOf } from "./bff-correlation";
import { clientErrorEvidence } from "./client-error-evidence";
import { reportClientDiagnostic } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";

let nextOrdinal = 0;

/** Records one browser selection/read on the existing stage lifecycle, without paths or content. */
export function startFilesNavigationEvidence(
  stage: ClientStageId,
  correlationId = newClientCorrelationId(),
): (response?: unknown) => void {
  const ordinal = ++nextOrdinal;
  const startedAt = performance.now();
  reportClientDiagnostic("Workspace navigation started", {
    correlationId,
    stageReport: { stage, phase: "started", ordinal },
  });
  return (response?: unknown): void => {
    reportClientDiagnostic("Workspace navigation settled", {
      correlationId,
      parentCorrelationId: responseCorrelationIdOf(response),
      stageReport: {
        stage,
        phase: "settled",
        ordinal,
        durationMs: Math.min(
          CLIENT_STAGE_DURATION_MS_MAX,
          Math.max(0, Math.round(performance.now() - startedAt)),
        ),
      },
    });
  };
}

export async function observeFilesDirectoryRead<T>(read: () => Promise<T>): Promise<T> {
  const correlationId = newClientCorrelationId();
  const settle = startFilesNavigationEvidence("files directory load", correlationId);
  let response: T | undefined;
  try {
    response = await read();
    return response;
  } catch (error: unknown) {
    reportClientDiagnostic("Workspace directory read failed", {
      correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    throw error;
  } finally {
    settle(response);
  }
}
