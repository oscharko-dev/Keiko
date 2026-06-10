// Operational metrics tests (Epic #750, Issue #760). Synthetic only. Asserts: reduction ratio,
// screen/render/design-token counts and augmentation share are computed exactly; optional nav-graph
// and a11y metrics are OMITTED ENTIRELY when their inputs are absent and present when supplied; and
// the metrics structure is entirely numeric (no name / id / link / token leakage by construction).

import { describe, expect, it } from "vitest";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { FigmaProvenance } from "../figmaConnector.js";
import type { FigmaSnapshot, FigmaSnapshotScreen } from "../figmaSnapshotTypes.js";
import {
  computeFigmaConnectorMetrics,
  type FigmaAugmentationTally,
} from "../figmaConnectorMetrics.js";

const PLANTED_BOARD_ID = "abcXYZfileKey789";
const PLANTED_SCREEN_NAME = "Onboarding · Personal Details";

const screen = (id: string, name: string): QualityIntelligenceFigma.ScreenIr => ({
  id,
  name,
  root: { id, name, type: "FRAME", interactionHint: "container", imageFills: [], children: [] },
});

const irResult = (
  screens: readonly QualityIntelligenceFigma.ScreenIr[],
  overrides: Partial<QualityIntelligenceFigma.ScreenIrResult> = {},
): QualityIntelligenceFigma.ScreenIrResult => ({
  screens,
  tokens: { colors: [], typography: [], spacing: [], radius: [] },
  links: [],
  reduction: { inputNodeCount: 100, keptNodeCount: 30, removedNodeCount: 70, removedRatio: 0.7 },
  ...overrides,
});

const provenance: FigmaProvenance = {
  fileKey: PLANTED_BOARD_ID,
  nodeId: "12:34",
  version: "v1",
  fetchedAt: "2026-06-09T00:00:00.000Z",
};

const snapshotScreen = (id: string): FigmaSnapshotScreen => ({
  screenId: id,
  ir: screen(id, "ignored"),
  image: { mimeType: "image/png", bytes: new Uint8Array([1, 2]), byteLength: 2, sha256: "abc" },
  integrityHash: "hash",
});

const snapshot = (renderedScreenIds: readonly string[]): FigmaSnapshot => ({
  snapshotSchemaVersion: 1,
  provenance,
  screens: renderedScreenIds.map(snapshotScreen),
  skippedScreens: [],
  integrityHash: "snap-hash",
});

const tokensFixture: QualityIntelligenceFigma.DesignTokens = {
  colors: [
    { id: "c1", kind: "color", value: "#fff" },
    { id: "c2", kind: "color", value: "#000" },
  ],
  typography: [
    {
      id: "t1",
      kind: "typography",
      fontFamily: "Inter",
      fontSize: 14,
      fontWeight: 400,
      lineHeight: 20,
    },
  ],
  spacing: [{ id: "s1", kind: "spacing", value: 8 }],
  radius: [{ id: "r1", kind: "radius", value: 4 }],
};

const tally = (deterministic: number, modelAugmented: number): FigmaAugmentationTally => ({
  deterministic,
  modelAugmented,
});

describe("computeFigmaConnectorMetrics", () => {
  it("computes reduction ratio, screen / render / design-token counts", () => {
    const ir = irResult([screen("a", "A"), screen("b", "B"), screen("c", "C")], {
      tokens: tokensFixture,
    });
    const metrics = computeFigmaConnectorMetrics(ir, snapshot(["a", "b"]), tally(8, 2));
    expect(metrics.reductionRatio).toBe(0.7);
    expect(metrics.screenCount).toBe(3);
    expect(metrics.renderCount).toBe(2); // one screen skipped → fewer renders than screens
    expect(metrics.designTokenCount).toBe(5); // 2 colors + 1 typo + 1 spacing + 1 radius
  });

  it("computes the deterministic-vs-model augmentation share", () => {
    const ir = irResult([screen("a", "A")]);
    const metrics = computeFigmaConnectorMetrics(ir, snapshot(["a"]), tally(8, 2));
    expect(metrics.augmentation.deterministic).toBe(8);
    expect(metrics.augmentation.modelAugmented).toBe(2);
    expect(metrics.augmentation.modelAugmentedShare).toBe(0.2);
  });

  it("reports a zero share (not NaN) when nothing was generated", () => {
    const ir = irResult([screen("a", "A")]);
    const metrics = computeFigmaConnectorMetrics(ir, snapshot([]), tally(0, 0));
    expect(metrics.augmentation.modelAugmentedShare).toBe(0);
    expect(metrics.renderCount).toBe(0);
  });

  it("rounds the share deterministically to 4 dp", () => {
    const ir = irResult([screen("a", "A")]);
    const metrics = computeFigmaConnectorMetrics(ir, snapshot(["a"]), tally(2, 1));
    expect(metrics.augmentation.modelAugmentedShare).toBe(0.3333);
  });

  it("includes the nav graph (screens + transitions) when the IR carries links", () => {
    const ir = irResult([screen("a", "A"), screen("b", "B")], {
      links: [
        { sourceNodeId: "a", trigger: "ON_CLICK", targetNodeId: "b" },
        { sourceNodeId: "b", trigger: "ON_CLICK", targetNodeId: "a" },
      ],
    });
    const metrics = computeFigmaConnectorMetrics(ir, snapshot(["a", "b"]), tally(1, 0));
    expect(metrics.navGraph).toEqual({ screens: 2, transitions: 2 });
  });

  it("OMITS nav graph entirely on a fully empty IR (no zero placeholder)", () => {
    const ir = irResult([]);
    const metrics = computeFigmaConnectorMetrics(ir, snapshot([]), tally(1, 0));
    expect("navGraph" in metrics).toBe(false);
  });

  it("OMITS a11y metrics when no a11y finding count is supplied, includes them when present", () => {
    const ir = irResult([screen("a", "A")]);
    const without = computeFigmaConnectorMetrics(ir, snapshot(["a"]), tally(1, 0));
    expect("a11y" in without).toBe(false);
    const withA11y = computeFigmaConnectorMetrics(ir, snapshot(["a"]), tally(1, 0), {
      a11yFindings: 3,
    });
    expect(withA11y.a11y).toEqual({ findings: 3 });
  });

  it("includes a11y findings of zero as a present-and-zero value (distinct from absent)", () => {
    const ir = irResult([screen("a", "A")]);
    const metrics = computeFigmaConnectorMetrics(ir, snapshot(["a"]), tally(1, 0), {
      a11yFindings: 0,
    });
    expect(metrics.a11y).toEqual({ findings: 0 });
  });

  it("produces an entirely numeric structure carrying no board id / screen name / token", () => {
    const ir = irResult([screen("a", PLANTED_SCREEN_NAME)], { tokens: tokensFixture });
    const metrics = computeFigmaConnectorMetrics(ir, snapshot(["a"]), tally(4, 1), {
      a11yFindings: 2,
    });
    const serialised = JSON.stringify(metrics);
    expect(serialised).not.toContain(PLANTED_SCREEN_NAME);
    expect(serialised).not.toContain(PLANTED_BOARD_ID);
    expect(serialised).not.toContain("figd_");
    expect(serialised).not.toContain("12:34");
  });
});
