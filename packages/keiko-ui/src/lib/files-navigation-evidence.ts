import type {
  ClientStageId,
  ClientNavigationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { CLIENT_STAGE_DURATION_MS_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "./bff-correlation";
import { clientErrorEvidence } from "./client-error-evidence";
import { reportClientDiagnostic, recordClientDiagnosticLoss } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";

let nextOrdinal = 0;
let readWindowStartedAt = 0;
let readStages = 0;
const MAX_READ_STAGES_PER_MINUTE = 8;

function readStageAvailable(): boolean {
  const now = Date.now();
  if (now - readWindowStartedAt >= 60_000) {
    readWindowStartedAt = now;
    readStages = 0;
  }
  if (readStages++ < MAX_READ_STAGES_PER_MINUTE) return true;
  recordClientDiagnosticLoss("postsThrottled", 2);
  return false;
}

export function resetFilesNavigationEvidenceForTests(): void {
  readWindowStartedAt = 0;
  readStages = 0;
}

/** Records one browser selection/read on the existing stage lifecycle, without paths or content. */
export interface FilesNavigationRead {
  readonly correlationId: string;
  readonly settle: (response?: unknown, outcome?: ClientNavigationOutcome) => void;
}

export function startFilesNavigationEvidence(
  stage: ClientStageId,
  correlationId = newClientCorrelationId(),
  parentCorrelationId?: string,
): (response?: unknown, navigationOutcome?: ClientNavigationOutcome) => void {
  const ordinal = ++nextOrdinal;
  const startedAt = performance.now();
  reportClientDiagnostic("Workspace navigation started", {
    correlationId,
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
    stageReport: { stage, phase: "started", ordinal },
  });
  let settled = false;
  return (_response?: unknown, navigationOutcome?: ClientNavigationOutcome): void => {
    if (settled) return;
    settled = true;
    reportClientDiagnostic("Workspace navigation settled", {
      correlationId,
      ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
      stageReport: {
        stage,
        phase: "settled",
        ordinal,
        ...(navigationOutcome === undefined ? {} : { navigationOutcome }),
        durationMs: Math.min(
          CLIENT_STAGE_DURATION_MS_MAX,
          Math.max(0, Math.round(performance.now() - startedAt)),
        ),
      },
    });
  };
}

export async function observeFilesDirectoryRead<T>(
  read: (correlationId: string) => Promise<T>,
  navigation?: FilesNavigationRead,
): Promise<T> {
  const correlationId = newClientCorrelationId();
  const settle = readStageAvailable()
    ? startFilesNavigationEvidence("files directory load", correlationId, navigation?.correlationId)
    : (): void => undefined;
  let response: T | undefined;
  let outcome: ClientNavigationOutcome = "failed";
  try {
    response = await read(correlationId);
    outcome = "applied";
    return response;
  } catch (error: unknown) {
    reportClientDiagnostic("Workspace directory read failed", {
      correlationId,
      ...(navigation === undefined ? {} : { parentCorrelationId: navigation.correlationId }),
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    throw Object.assign(new Error("Workspace directory read failed", { cause: error }), {
      correlationId,
    });
  } finally {
    settle(response, outcome);
    navigation?.settle(response, outcome);
  }
}
