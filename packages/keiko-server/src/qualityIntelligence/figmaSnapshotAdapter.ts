// figmaSnapshotAdapter.ts — Figma-snapshot source seam for QI ingestion (Epic #750, Issue #754).
//
// Two server-tier seams the pure-domain ingestion cannot own:
//
//   1. The snapshot LOADER — reads the immutable Figma Snapshot evidence record for a runId through
//      the existing keiko-evidence store (`createNodeFigmaSnapshotStore(evidenceDir).load`). It
//      reads ONLY the stored snapshot and never contacts Figma. Returns `undefined` when no
//      evidence dir is configured, so the ingestion layer rejects the source with a coded error.
//
//   2. The capability-routed VISION hint provider — consults `resolveQiMultimodalSelection` (#810)
//      to decide whether a multimodal model is available; when one is, it MAY call an injected
//      `visionCall` to recover image-derived semantics, returning them as additive hints. There is
//      NO hard-coded model id. On "unavailable", a thrown call, or a non-array/garbage result the
//      provider returns `[]`, so the source degrades silently to the deterministic IR-only baseline.
//      No model port is wired here yet, so the default provider is IR-only by construction — the
//      seam is ready for the multimodal port without any further refactor of the ingestion path.

import {
  createNodeFigmaSnapshotStore,
  type FigmaSnapshotRecord,
} from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../deps.js";
import { resolveQiMultimodalSelection } from "./modelSelection.js";

/** Loads an immutable Figma Snapshot evidence record by runId. Returns `undefined` when not found. */
export type FigmaSnapshotLoader = (snapshotRunId: string) => FigmaSnapshotRecord | undefined;

/**
 * Build the snapshot loader. Returns `undefined` when `deps.evidenceDir` is not configured so the
 * ingestion layer maps an attempted figma-snapshot source to QI_FIGMA_SNAPSHOT_UNAVAILABLE.
 */
export function makeFigmaSnapshotLoader(deps: UiHandlerDeps): FigmaSnapshotLoader | undefined {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) return undefined;
  const store = createNodeFigmaSnapshotStore(evidenceDir);
  return (snapshotRunId: string): FigmaSnapshotRecord | undefined => {
    try {
      return store.load(snapshotRunId);
    } catch {
      // A malformed / unreadable record is treated as "not found"; the caller emits a coded error.
      return undefined;
    }
  };
}

/** The image-derived semantics a multimodal model recovered for one screen, as additive hints. */
export interface FigmaVisionScreenRequest {
  readonly screenId: string;
  /** The image side-file reference recorded in the snapshot (relative path + sha256). */
  readonly imageRelativePath: string;
  /** The deterministic baseline text, supplied so the model cross-checks rather than re-derives. */
  readonly baselineText: string;
}

/**
 * Produces additive vision hints for a screen, OR an empty list when vision is unavailable / failed.
 * The contract is total: it NEVER throws and NEVER returns a value that could override the IR — the
 * caller appends the hints below the baseline.
 */
export type FigmaVisionHintProvider = (request: FigmaVisionScreenRequest) => readonly string[];

/**
 * A raw vision call: given a screen request and the selected model id, return image-derived hint
 * strings. Injected so this module imports no provider SDK and stays testable. Absent in production
 * until the multimodal port lands (#810 follow-up) — its absence is exactly the IR-only path.
 */
export type FigmaVisionCall = (
  request: FigmaVisionScreenRequest,
  modelId: string,
) => readonly string[];

function sanitiseCallResult(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Build a capability-routed vision hint provider. When no multimodal capability is configured (or no
 * `visionCall` is injected), every request returns `[]` — the deterministic IR-only baseline path.
 * When a multimodal model IS available, the provider routes the call through it; any thrown error or
 * garbage result is swallowed to `[]` so a misbehaving model can never break the run or override the
 * structural baseline. No model id is hard-coded — selection is via `resolveQiMultimodalSelection`.
 */
export function makeFigmaVisionHintProvider(
  deps: UiHandlerDeps,
  visionCall?: FigmaVisionCall,
): FigmaVisionHintProvider {
  const selection = resolveQiMultimodalSelection(deps);
  if (selection.kind === "unavailable" || visionCall === undefined) {
    return () => [];
  }
  const { modelId } = selection;
  return (request: FigmaVisionScreenRequest): readonly string[] => {
    try {
      return sanitiseCallResult(visionCall(request, modelId));
    } catch {
      return [];
    }
  };
}
