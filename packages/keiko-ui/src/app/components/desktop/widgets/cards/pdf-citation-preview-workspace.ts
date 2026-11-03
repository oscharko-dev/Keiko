import { newClientCorrelationId } from "@/lib/bff-correlation";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import type { PdfPreviewWorkspaceWindow } from "./pdf-citation-preview-session";

type PreviewRegistryModule = Pick<
  typeof import("./pdf-citation-preview-session"),
  "syncPdfCitationPreviewWindowRegistry"
>;

/** Defer preview bookkeeping and retain only the membership snapshot this effect owns. */
export function syncDeferredPdfPreviewWorkspace(
  wins: readonly PdfPreviewWorkspaceWindow[] | null,
  load: () => Promise<PreviewRegistryModule> = () => import("./pdf-citation-preview-session"),
): () => void {
  let active = true;
  const snapshot =
    wins?.map((win) => ({
      id: win.id,
      type: win.type,
      minimized: win.minimized === true,
      cfg: typeof win.cfg["chatId"] === "string" ? { chatId: win.cfg["chatId"] } : {},
    })) ?? null;
  void load()
    .then((registry): void => {
      if (active) registry.syncPdfCitationPreviewWindowRegistry(snapshot);
    })
    .catch((error: unknown): void => {
      if (!active) return;
      reportClientDiagnostic("PDF preview workspace registry unavailable", {
        correlationId: newClientCorrelationId(),
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
    });
  return (): void => {
    active = false;
  };
}
