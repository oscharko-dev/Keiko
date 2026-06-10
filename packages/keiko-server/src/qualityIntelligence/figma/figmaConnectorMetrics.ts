// Operational metrics for the Figma connector (Epic #750, Issue #760).
//
// A small, typed, PURE structure derived ENTIRELY from the stored Snapshot boundary inputs — the
// deterministic Screen-IR (#752) and the assembled Snapshot (#753) — plus a decoupled augmentation
// tally. Figma is never contacted here; metrics read only what the bounded snapshot-build already
// produced.
//
// GOVERNANCE (load-bearing, #760): every field is a NUMBER. No screen name, no board id / link /
// name, no design content, no token ever enters this structure. The augmentation tally is supplied
// by the QI source (#754) as two integers; this module does not inspect any test/candidate content.
//
// Optional `navGraph` and `a11y` are OMITTED ENTIRELY when their inputs are absent — the navigation
// graph (#811) and a11y baseline (#812) are not merged yet, and a later child wires them in
// additively. We never emit a zero/placeholder for an unmerged capability, so "absent" stays
// distinguishable from "present and zero".

import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { FigmaSnapshot } from "./figmaSnapshotTypes.js";

/** Deterministic-vs-model augmentation tally. Supplied by the QI source (#754) as plain counts. */
export interface FigmaAugmentationTally {
  readonly deterministic: number;
  readonly modelAugmented: number;
}

export interface FigmaAugmentationShare {
  readonly deterministic: number;
  readonly modelAugmented: number;
  /** modelAugmented / (deterministic + modelAugmented), rounded to 4 dp; 0 when the total is 0. */
  readonly modelAugmentedShare: number;
}

/** Optional navigation-graph cardinalities (#811). Present only when links/screens are supplied. */
export interface FigmaNavGraphMetrics {
  readonly screens: number;
  readonly transitions: number;
}

/** Optional a11y-finding cardinalities (#812). Present only when a finding count is supplied. */
export interface FigmaA11yMetrics {
  readonly findings: number;
}

export interface FigmaConnectorMetrics {
  /** Share of the raw subtree removed by deterministic cleaning, in [0, 1]. */
  readonly reductionRatio: number;
  readonly screenCount: number;
  /** Screens that produced a render in the Snapshot (≤ screenCount; the rest are skippedScreens). */
  readonly renderCount: number;
  readonly designTokenCount: number;
  readonly augmentation: FigmaAugmentationShare;
  readonly navGraph?: FigmaNavGraphMetrics;
  readonly a11y?: FigmaA11yMetrics;
}

/** Optional, additive metric inputs from siblings not yet merged. */
export interface FigmaConnectorMetricsExtras {
  /** A11y finding count from #812. Omit when the a11y baseline did not run. */
  readonly a11yFindings?: number;
}

const ROUND = 10_000;

const roundShare = (value: number): number => Math.round(value * ROUND) / ROUND;

const computeShare = (tally: FigmaAugmentationTally): FigmaAugmentationShare => {
  const total = tally.deterministic + tally.modelAugmented;
  return {
    deterministic: tally.deterministic,
    modelAugmented: tally.modelAugmented,
    modelAugmentedShare: total === 0 ? 0 : roundShare(tally.modelAugmented / total),
  };
};

const countDesignTokens = (tokens: QualityIntelligenceFigma.DesignTokens): number =>
  tokens.colors.length + tokens.typography.length + tokens.spacing.length + tokens.radius.length;

// The navigation graph is present whenever the IR carried any screens or links — i.e. the source
// material for #811 exists. We never synthesise it from nothing: an empty IR yields no nav graph.
const navGraphOf = (
  ir: QualityIntelligenceFigma.ScreenIrResult,
): FigmaNavGraphMetrics | undefined => {
  if (ir.screens.length === 0 && ir.links.length === 0) return undefined;
  return { screens: ir.screens.length, transitions: ir.links.length };
};

/**
 * Compute the operational metrics from the deterministic IR, the assembled Snapshot, the
 * augmentation tally, and any additive sibling inputs. Pure: same inputs → byte-identical metrics.
 */
export const computeFigmaConnectorMetrics = (
  ir: QualityIntelligenceFigma.ScreenIrResult,
  snapshot: FigmaSnapshot,
  augmentation: FigmaAugmentationTally,
  extras: FigmaConnectorMetricsExtras = {},
): FigmaConnectorMetrics => {
  const navGraph = navGraphOf(ir);
  return {
    reductionRatio: ir.reduction.removedRatio,
    screenCount: ir.screens.length,
    renderCount: snapshot.screens.length,
    designTokenCount: countDesignTokens(ir.tokens),
    augmentation: computeShare(augmentation),
    ...(navGraph !== undefined ? { navGraph } : {}),
    ...(extras.a11yFindings !== undefined ? { a11y: { findings: extras.a11yFindings } } : {}),
  };
};
