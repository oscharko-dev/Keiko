import { randomUUID } from "node:crypto";
import { createNodeFigmaSnapshotStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic } from "../diagnostics-log.js";

export function openFigmaSnapshotStore(
  evidenceDir: string,
  deps: Pick<UiHandlerDeps, "diagnostics">,
  correlationId: string = randomUUID(),
): ReturnType<typeof createNodeFigmaSnapshotStore> {
  return createNodeFigmaSnapshotStore(evidenceDir, {
    reportFailure: (stage) => {
      emitServerDiagnostic(deps.diagnostics, {
        correlationId,
        timestamp: new Date().toISOString(),
        operation: "figma.snapshotStore",
        source: `figmaSnapshotStore.${stage}`,
        errorClass: "EvidenceStoreError",
        message: "figma-internal-error",
      });
    },
  });
}
