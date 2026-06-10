// Design-to-code generation from a stored Figma Snapshot (Epic #750, Issue #755).
//
//   POST /api/figma/snapshots/:runId/code — emit reviewable frontend code for a built snapshot.
//
// This is the missing runnable seam for #755: the pure emission domain (emitCode + htmlCssAdapter +
// the CodeTargetAdapter seam) shipped, but no route/run consumed it, so the capability was unreachable
// from a user. The run reads ONLY the stored snapshot (the communication boundary holds — no Figma,
// no model, no network, no filesystem beyond the local evidence write), builds the deterministic
// target-neutral emission plan from the Screen-IR + the persisted design tokens (#752) + the routing
// hints derived from the persisted inter-screen links (#811), renders semantic HTML/CSS through the
// first-slice html-css adapter, and returns a reviewable artifact (a proposal — never auto-applied).
//
// Determinism + model-independence (#755 DoD): emission is pure and model-free, so the same stored
// snapshot yields a byte-identical artifact; semantic naming (the only model-augmentation point) is
// additive and absent here, so the structural defaults are used. Evidence-backed: the artifact is
// persisted to the local evidence dir through the reused contained-store seam. Gated: CSRF + a valid
// stored runId. No hidden external effects: nothing leaves the box, the snapshot is never mutated.

import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  createNodeContainedJsonArtifactStore,
  createNodeFigmaSnapshotStore,
  type FigmaSnapshotRecord,
} from "@oscharko-dev/keiko-evidence";
import { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";

const FIGMA_CODEGEN_SUFFIX = ".figma-codegen.json";
const FIGMA_CODEGEN_SCHEMA_VERSION = 1 as const;

/** The persisted, reviewable code artifact (evidence-backed; deterministic, carries no timestamp). */
export interface PersistedFigmaCodeArtifact {
  readonly figmaCodegenSchemaVersion: typeof FIGMA_CODEGEN_SCHEMA_VERSION;
  readonly runId: string;
  readonly adapterName: string;
  readonly files: readonly { readonly path: string; readonly contents: string }[];
}

/** Browser-safe response: the reviewable file set plus a small summary. No token, no board id. */
export interface FigmaCodegenResponse {
  readonly runId: string;
  readonly adapterName: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly screenCount: number;
  readonly files: readonly { readonly path: string; readonly contents: string }[];
}

const errorBody = (
  code: string,
  message: string,
): { error: { code: string; message: string } } => ({
  error: { code, message },
});

// Re-hydrate the deterministic emission input from the stored snapshot. Unparseable screens are
// dropped (never crash). Links → nav graph → routing hints feed the adapter's screen-to-screen wiring.
function emissionInputFromRecord(
  record: FigmaSnapshotRecord,
): QualityIntelligenceFigma.EmissionInput {
  const screens = record.screens
    .map((s) => QualityIntelligenceFigma.parseScreenIr(s.irJson))
    .filter((s): s is QualityIntelligenceFigma.ScreenIr => s !== undefined);
  const tokens = QualityIntelligenceFigma.parseDesignTokens(record.tokens);
  const links: QualityIntelligenceFigma.InterScreenLink[] = (record.links ?? []).map((l) => ({
    sourceNodeId: l.sourceNodeId,
    trigger: l.trigger,
    targetNodeId: l.targetNodeId,
  }));
  const graph = QualityIntelligenceFigma.deriveNavGraph({
    screens,
    links,
    tokens,
    reduction: { inputNodeCount: 0, keptNodeCount: 0, removedNodeCount: 0, removedRatio: 0 },
  });
  return { screens, tokens, hints: QualityIntelligenceFigma.deriveRoutingHints(graph) };
}

function persistArtifact(evidenceDir: string, artifact: PersistedFigmaCodeArtifact): void {
  // Evidence-backed (#755): the reviewable artifact is written through the reused contained-store
  // seam. Best-effort — a failed evidence write must not fail the (already-computed) reviewable
  // response, so the caller still returns the code; the persist is the durability layer.
  try {
    createNodeContainedJsonArtifactStore<PersistedFigmaCodeArtifact>(
      evidenceDir,
      FIGMA_CODEGEN_SUFFIX,
      {
        parse: (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as Record<string, unknown>).figmaCodegenSchemaVersion ===
            FIGMA_CODEGEN_SCHEMA_VERSION
            ? (value as PersistedFigmaCodeArtifact)
            : undefined,
      },
    ).record(artifact.runId, artifact);
  } catch {
    // swallow: the response below is the source of truth for the operator's review.
  }
}

// ─── POST /api/figma/snapshots/:runId/code ─────────────────────────────────────

// Resolve evidenceDir + runId, load + 404 the stored snapshot, or return a coded RouteResult.
function loadSnapshotForCodegen(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): { record: FigmaSnapshotRecord; evidenceDir: string; runId: string } | RouteResult {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return {
      status: 503,
      body: errorBody("FIGMA_NO_EVIDENCE_DIR", "The evidence directory is not configured."),
    };
  }
  const runId = ctx.params.runId ?? "";
  if (runId.length === 0) {
    return { status: 400, body: errorBody("FIGMA_SNAPSHOT_NOT_FOUND", "Missing snapshot run id.") };
  }
  let record: FigmaSnapshotRecord | undefined;
  try {
    record = createNodeFigmaSnapshotStore(evidenceDir).load(runId);
  } catch {
    return {
      status: 500,
      body: errorBody("FIGMA_INTERNAL", "The snapshot could not be read for code generation."),
    };
  }
  if (record === undefined) {
    return {
      status: 404,
      body: errorBody("FIGMA_SNAPSHOT_NOT_FOUND", "No snapshot was found for this run id."),
    };
  }
  return { record, evidenceDir, runId };
}

export function handleFigmaGenerateCode(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const loaded = loadSnapshotForCodegen(ctx, deps);
  if ("status" in loaded) return loaded;
  const { record, evidenceDir, runId } = loaded;

  const input = emissionInputFromRecord(record);
  if (input.screens.length === 0) {
    return {
      status: 422,
      body: errorBody(
        "FIGMA_CODEGEN_NO_SCREENS",
        "The snapshot has no usable screen to generate code from.",
      ),
    };
  }

  const artifact = QualityIntelligenceFigma.emitCode(
    input,
    QualityIntelligenceFigma.htmlCssAdapter,
  );
  const persisted: PersistedFigmaCodeArtifact = {
    figmaCodegenSchemaVersion: FIGMA_CODEGEN_SCHEMA_VERSION,
    runId,
    adapterName: artifact.adapterName,
    files: artifact.files,
  };
  persistArtifact(evidenceDir, persisted);

  const totalBytes = artifact.files.reduce((sum, f) => sum + Buffer.byteLength(f.contents), 0);
  const response: FigmaCodegenResponse = {
    runId,
    adapterName: artifact.adapterName,
    fileCount: artifact.files.length,
    totalBytes,
    screenCount: input.screens.length,
    files: artifact.files,
  };
  return { status: 200, body: response };
}
