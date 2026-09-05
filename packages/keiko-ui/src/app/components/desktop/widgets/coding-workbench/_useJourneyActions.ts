import { useRef, useState } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { correlationIdOf } from "@/lib/client-error-summary";

type JourneyAction = "refresh" | "propose-ready";
interface JourneyActions {
  readonly busy: boolean;
  readonly failure: JourneyAction | null;
  readonly invoke: (action: JourneyAction, callback: () => void | Promise<void>) => Promise<void>;
}
export function useJourneyActions(runId: string): JourneyActions {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<JourneyAction | null>(null);
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
      setFailure(action);
      reportClientDiagnostic(`[keiko] journey action: ${action} failed`, {
        correlationId: correlationIdOf(error) ?? runId,
      });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { busy, failure, invoke };
}
