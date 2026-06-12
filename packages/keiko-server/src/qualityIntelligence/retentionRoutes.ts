// Quality Intelligence run-deletion BFF route (Epic #270, Issue #282 follow-up; ADR-0023 D8).
//
//   * DELETE /api/quality-intelligence/runs/:id — delete a run and ALL its local companions
//
// ADR-0023 (lines ~487-492) assigns the deletion-control wiring to the consuming epic: a UI/BFF
// delete action -> `deleteQualityIntelligenceRun` (the hardened keiko-evidence primitive) passing
// the SERVER-owned `companionSuffixes`. This route is that wiring. It passes EVERY server-owned
// companion so a deleted run leaves no orphaned customer-derived content (Stop-Condition b:
// lifecycle must not bypass retention semantics): `.review.json` (reviewer labels + the append-only
// review audit log, Issue #282), the three figma connector companions, the figma snapshot record,
// and the figma snapshot side-file directory. `.candidates.json` is evidence-owned and always swept
// by the primitive. CSRF is enforced by the dispatch layer for mutating methods.

import { join } from "node:path";
import {
  deleteQualityIntelligenceRun,
  loadQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";

// Companion artifacts written alongside the run manifest under `qi/` that are owned by HIGHER layers
// (keiko-server), not by keiko-evidence. The primitive ALWAYS sweeps the evidence-owned
// `.candidates.json`; these must be passed explicitly or a deleted run orphans them. Kept in one
// place so a new server-owned companion is added here rather than rediscovered per call site.
const SERVER_OWNED_COMPANION_SUFFIXES: readonly string[] = [
  ".review.json", // Issue #282 — reviewer labels + append-only review audit log
  ".figma-codegen.json", // Epic #750 — figma code-generation companion
  ".figma-audit.json", // Epic #750 — figma connector audit companion
  ".figma-consent.json", // Epic #750 — figma consent companion
  ".figma-snapshot.json", // Epic #750 — figma snapshot record
];

// The QI evidence sub-directory and the figma snapshot side-file sub-directory, mirrored from
// keiko-evidence (`QI_SUBDIR` / `SIDE_FILE_SUBDIR`). `sideFileRoot` lets the primitive remove
// `<evidenceDir>/qi/figma-snapshots/<runId>/` (binary snapshot side-files) alongside the manifest.
const QI_SUBDIR = "qi";
const QI_SNAPSHOT_SIDE_FILE_SUBDIR = "figma-snapshots";

const errorResult = (status: number, code: string, message: string): RouteResult => ({
  status,
  body: { error: { code, message } },
});

export function handleQiDeleteRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  try {
    // Not-found is an explicit 404 (the primitive itself is idempotent and would report "absent",
    // but the BFF gives the caller a clear signal that nothing was there to delete).
    if (loadQualityIntelligenceRun(id, { evidenceDir }) === undefined) {
      return errorResult(404, "QI_NOT_FOUND", "Quality Intelligence run not found.");
    }
    const receipt = deleteQualityIntelligenceRun(id, {
      evidenceDir,
      companionSuffixes: SERVER_OWNED_COMPANION_SUFFIXES,
      sideFileRoot: join(evidenceDir, QI_SUBDIR, QI_SNAPSHOT_SIDE_FILE_SUBDIR),
    });
    return {
      status: 200,
      body: {
        runId: receipt.runId,
        status: receipt.status,
        removedCompanionSuffixes: receipt.removedCompanionSuffixes,
      },
    };
  } catch {
    return errorResult(500, "QI_DELETE_FAILED", "Failed to delete the Quality Intelligence run.");
  }
}

export const QI_RETENTION_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "DELETE", pattern: "/api/quality-intelligence/runs/:id", handler: handleQiDeleteRun },
];
