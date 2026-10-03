import { useCallback, useEffect, useRef } from "react";
import { createProject } from "@/lib/api";
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

export function useEditorProjectConnection({
  root,
  onNotice,
  onBusy,
}: ConnectionOptions): (path: string, ready: (root: string) => void) => Promise<void> {
  const t = useFilesWidgetTranslate();
  const sequence = useRef(0);
  const connecting = useRef(false);
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [root],
  );
  return useCallback(
    async (path: string, ready: (root: string) => void): Promise<void> => {
      if (connecting.current) return;
      connecting.current = true;
      const request = ++sequence.current;
      const correlationId = newClientCorrelationId();
      const settle = startFilesNavigationEvidence("editor project selection", correlationId);
      onNotice(null);
      onBusy?.(true);
      try {
        const response = await createProject({ path }, correlationId);
        if (request !== sequence.current) return;
        if (response.project.workspaceAvailable !== true) {
          onNotice(t("tree.connectionFailed"));
          reportClientDiagnostic("Editor project membership unavailable", {
            correlationId,
            errorKind: "unavailable",
          });
          return;
        }
        onNotice(null);
        ready(response.project.path);
      } catch (error: unknown) {
        if (request !== sequence.current) return;
        onNotice(t("tree.connectionFailed"));
        reportClientDiagnostic("Editor project connection failed", {
          correlationId,
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
        });
      } finally {
        connecting.current = false;
        if (request === sequence.current) onBusy?.(false);
        settle();
      }
    },
    [onBusy, onNotice, t],
  );
}
