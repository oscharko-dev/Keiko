import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ClientNavigationOutcome } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { createProject, projectResponseWarningMessage } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { startFilesNavigationEvidence } from "@/lib/files-navigation-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { useFilesWidgetTranslate } from "./files-widget-i18n";

interface ConnectionOptions {
  readonly root: string;
  readonly onNotice: (message: string | null) => void;
  readonly onBusy?: (busy: boolean) => void;
}

type ConnectedRootAction = (
  root: string,
  correlationId: string,
  warning?: string,
  warningCorrelationId?: string,
) => ClientNavigationOutcome | void;

interface PendingConnection {
  readonly sequence: number;
  readonly settle: ReturnType<typeof startFilesNavigationEvidence>;
}

interface ConnectionRun {
  readonly path: string;
  readonly intent: "explicit-folder-selection" | "file-navigation";
  readonly correlationId: string;
  readonly request: PendingConnection;
  readonly currentSequence: () => number;
  readonly ready: ConnectedRootAction;
  readonly onNotice: ConnectionOptions["onNotice"];
  readonly failedNotice: string;
}

async function runConnection(run: ConnectionRun): Promise<ClientNavigationOutcome> {
  try {
    const response = await createProject(
      { path: run.path, selectionIntent: run.intent },
      run.correlationId,
    );
    if (run.request.sequence !== run.currentSequence()) return "stale";
    if (response.project.workspaceAvailable !== true) {
      run.onNotice(run.failedNotice);
      reportClientDiagnostic("Editor project membership unavailable", {
        correlationId: run.correlationId,
        errorKind: "unavailable",
      });
      return "unavailable";
    }
    const warning = projectResponseWarningMessage(response);
    run.onNotice(warning ?? null);
    return (
      run.ready(
        response.project.path,
        run.correlationId,
        warning,
        response.warning?.correlationId,
      ) ?? "applied"
    );
  } catch (error: unknown) {
    if (run.request.sequence !== run.currentSequence()) return "stale";
    run.onNotice(run.failedNotice);
    reportClientDiagnostic("Editor project connection failed", {
      correlationId: run.correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return "failed";
  }
}

function cancelPendingConnection(
  pending: RefObject<PendingConnection | null>,
  busy: ConnectionOptions["onBusy"],
): void {
  pending.current?.settle(undefined, "cancelled");
  pending.current = null;
  busy?.(false);
}

export function useEditorProjectConnection({
  root,
  onNotice,
  onBusy,
}: ConnectionOptions): (
  path: string,
  ready: ConnectedRootAction,
  selectionIntent?: "explicit-folder-selection" | "file-navigation",
) => Promise<void> {
  const t = useFilesWidgetTranslate();
  const sequence = useRef(0);
  const pending = useRef<PendingConnection | null>(null);
  const busy = useRef(onBusy);
  busy.current = onBusy;
  useEffect(
    (): (() => void) => (): void => {
      sequence.current += 1;
      cancelPendingConnection(pending, busy.current);
    },
    [root],
  );
  return useCallback(
    async (path, ready, selectionIntent = "explicit-folder-selection"): Promise<void> => {
      const correlationId = newClientCorrelationId();
      const settle = startFilesNavigationEvidence("editor project selection", correlationId);
      if (pending.current !== null) return settle(undefined, "dropped");
      const request = { sequence: ++sequence.current, settle };
      pending.current = request;
      onNotice(null);
      onBusy?.(true);
      const outcome = await runConnection({
        path,
        intent: selectionIntent,
        correlationId,
        request,
        currentSequence: (): number => sequence.current,
        ready,
        onNotice,
        failedNotice: t("tree.connectionFailed"),
      });
      if (pending.current === request) {
        pending.current = null;
        onBusy?.(false);
      }
      settle(undefined, outcome);
    },
    [onBusy, onNotice, t],
  );
}
