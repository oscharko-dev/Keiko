// Explicit, on-demand FULL re-snapshot of a Figma scope (Epic #750, Issue #759; drift #735).
//
// A re-snapshot is a DELIBERATE caller action — never a webhook, never a poll, never a designer
// signal. It performs a fresh, scoped, FULL re-fetch of the same board scope and rebuilds the
// immutable Snapshot from scratch: scoped nodes fetch → deterministic IR clean → render. There is
// NO delta and NO incremental skip of "unchanged" screens — every screen in scope is re-fetched
// and re-rendered. Because the Snapshot integrity hash is deterministic and excludes wall-clock
// time, two re-snapshots of an unchanged design hash identically; a changed design changes the
// hash. That hash compare IS the drift signal (#735) — this module performs the re-snapshot; the
// comparison is the caller's, and Figma is contacted ONLY here, within the snapshot boundary.

import type { FigmaConnector, FigmaFetchOptions } from "./figmaConnector.js";
import type { FigmaHttpPort } from "./figmaHttpPort.js";
import type { FigmaRenderPort } from "./figmaRenderPort.js";
import { buildFigmaSnapshot, type BuildFigmaSnapshotInput } from "./figmaSnapshotBuilder.js";
import type { FigmaSnapshot } from "./figmaSnapshotTypes.js";
import type { FigmaRetryPolicy, FigmaRetrySleep } from "./figmaRetry.js";
import type { FigmaScopedResult } from "./figmaConnector.js";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";

/** Deterministic clean of the raw scoped nodes into the per-screen IR (#752 lives behind this seam). */
export type FigmaCleanToIr = (scoped: FigmaScopedResult) => QualityIntelligenceFigma.ScreenIrResult;

export interface ResnapshotFigmaDeps {
  readonly connector: FigmaConnector;
  readonly cleanToIr: FigmaCleanToIr;
  readonly token: string;
  readonly imagesPort: FigmaHttpPort;
  readonly renderPort: FigmaRenderPort;
  readonly batchSize?: number;
  readonly maxImageBytes?: number;
  readonly downloadConcurrency?: number;
  readonly retryPolicy?: FigmaRetryPolicy;
  readonly sleep?: FigmaRetrySleep;
}

/**
 * Perform an explicit full scoped re-snapshot of `url`. Re-fetches the whole scope and rebuilds
 * the Snapshot — no delta, no incremental reuse. `options.version` pins the re-fetch to a named
 * Figma version so the re-snapshot stays within the configured scope.
 */
export const resnapshotFigma = async (
  url: string,
  deps: ResnapshotFigmaDeps,
  options: FigmaFetchOptions = {},
): Promise<FigmaSnapshot> => {
  // Deep scoped-pagination fetch (#837): a re-snapshot must capture the same in-screen text the
  // initial build does, so the regenerated drift baseline (#735) is comparable. Still a FULL,
  // explicit, on-demand re-fetch — no delta, no incremental skip — within the snapshot boundary.
  const scoped = await deps.connector.fetchScopedNodesDeep(url, options);
  const ir = deps.cleanToIr(scoped);

  const buildInput: BuildFigmaSnapshotInput = {
    ir,
    provenance: scoped.provenance,
    token: deps.token,
    imagesPort: deps.imagesPort,
    renderPort: deps.renderPort,
    ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
    ...(deps.maxImageBytes !== undefined ? { maxImageBytes: deps.maxImageBytes } : {}),
    ...(deps.downloadConcurrency !== undefined
      ? { downloadConcurrency: deps.downloadConcurrency }
      : {}),
    ...(deps.retryPolicy !== undefined ? { retryPolicy: deps.retryPolicy } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  };

  return buildFigmaSnapshot(buildInput);
};
