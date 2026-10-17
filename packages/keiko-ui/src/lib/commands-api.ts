/**
 * Typed fetch wrapper for the four /api/commands/* BFF routes (Issue #1387).
 * Mirrors lib/terminal-api.ts: same-origin relative paths, CSRF header on
 * state-changing methods, no response-body logging.
 */

import { bffFetchJson, bffRequestErrorKind, newClientCorrelationId } from "./http";
import { ApiError } from "./api-shared-primitives";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";
import { correlationIdOf } from "./client-error-summary";
import {
  validateCommandTaskCatalog,
  validateCommandTaskRunResult,
} from "@oscharko-dev/keiko-contracts/runtime/command-runner";
import type { CommandTaskCatalog, CommandTaskRunRequest, CommandTaskRunResult } from "./types";

function reportCommandResponseFailure(
  kind: "catalog" | "run",
  error: unknown,
  correlationId: string,
  validationFailed: boolean,
): void {
  reportClientDiagnostic(`Keiko command response failed (kind=${kind}).`, {
    kind: "other",
    correlationId: correlationIdOf(error) ?? correlationId,
    errorKind: validationFailed ? "validation-failed" : bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
}

export async function fetchCommandCatalog(projectId: string): Promise<CommandTaskCatalog> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  const correlationId = newClientCorrelationId();
  let validationFailed = false;
  let emptyBodyRefused = false;
  try {
    return await bffFetchJson<CommandTaskCatalog>(
      `/api/commands/catalog?${params.toString()}`,
      undefined,
      {
        correlationId,
        validator: (_path, value) => {
          const parsed = validateCommandTaskCatalog(value);
          if (parsed.ok) return parsed.value;
          validationFailed = true;
          emptyBodyRefused = value === undefined;
          throw new ApiError(
            "CONTRACT_VALIDATION_FAILED",
            "Command catalog response failed contract validation.",
            502,
          );
        },
      },
    );
  } catch (error) {
    if (!emptyBodyRefused)
      reportCommandResponseFailure("catalog", error, correlationId, validationFailed);
    throw error;
  }
}

export async function createCommandRun(
  input: CommandTaskRunRequest,
): Promise<CommandTaskRunResult> {
  const correlationId = newClientCorrelationId();
  let validationFailed = false;
  let emptyBodyRefused = false;
  try {
    return await bffFetchJson<CommandTaskRunResult>(
      "/api/commands/runs",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      {
        correlationId,
        validator: (_path, value) => {
          const parsed = validateCommandTaskRunResult(value);
          if (parsed.ok) return parsed.value;
          validationFailed = true;
          emptyBodyRefused = value === undefined;
          throw new ApiError(
            "CONTRACT_VALIDATION_FAILED",
            "Command run response failed contract validation.",
            502,
          );
        },
      },
    );
  } catch (error) {
    if (!emptyBodyRefused)
      reportCommandResponseFailure("run", error, correlationId, validationFailed);
    throw error;
  }
}

export async function cancelCommandRun(runId: string): Promise<void> {
  await bffFetchJson<void>(`/api/commands/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
}

export function commandEventsUrl(): string {
  return "/api/commands/events";
}
