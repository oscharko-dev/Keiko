import { useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

type JourneyAction = "refresh" | "propose-ready";

/**
 * A body-free description of why a journey action failed (B5-2, epic #3384 audit finding
 * B5-2). `reason` is never the caught error's raw `message` or stack — only `ApiError.code`
 * (the BFF's own closed-vocabulary failure code, e.g. `GATEWAY_TIMEOUT`) when the failure went
 * through `bffFetchJson`, or `clientErrorSummary(error)`'s bounded class name (e.g.
 * `TypeError`, `AbortError`) for a native throw the BFF never saw. Both are already sanctioned
 * body-free identifiers (api-shared-primitives.ts, client-error-summary.ts) — this hook derives
 * one instead of discarding the caught error entirely, so a network failure, an expired
 * approval, and a quota-exceeded rejection stop rendering as the same generic text.
 */
export interface JourneyActionFailure {
  readonly action: JourneyAction;
  readonly reason: string;
}

function journeyFailureReason(error: unknown): string {
  return error instanceof ApiError ? error.code : clientErrorSummary(error);
}

interface JourneyActions {
  readonly busy: boolean;
  readonly failure: JourneyActionFailure | null;
  readonly invoke: (action: JourneyAction, callback: () => void | Promise<void>) => Promise<void>;
}
export function useJourneyActions(runId: string): JourneyActions {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<JourneyActionFailure | null>(null);
  const invoke = async (
    action: JourneyAction,
    callback: () => void | Promise<void>,
  ): Promise<void> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailure(null);
    reportClientDiagnostic(`[keiko] journey action: ${action} started`, { correlationId: runId });
    try {
      await callback();
      reportClientDiagnostic(`[keiko] journey action: ${action} completed`, {
        correlationId: runId,
      });
    } catch (error) {
      const reason = journeyFailureReason(error);
      setFailure({ action, reason });
      reportClientDiagnostic(`[keiko] journey action: ${action} failed (reason=${reason})`, {
        correlationId: correlationIdOf(error) ?? runId,
      });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { busy, failure, invoke };
}
