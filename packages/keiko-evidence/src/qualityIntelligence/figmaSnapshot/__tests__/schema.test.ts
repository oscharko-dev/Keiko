import { describe, expect, it } from "vitest";
import { FIGMA_SNAPSHOT_SCHEMA_VERSION, validateFigmaSnapshotRecord } from "../schema.js";

const validRecord = (): Record<string, unknown> => ({
  figmaSnapshotSchemaVersion: FIGMA_SNAPSHOT_SCHEMA_VERSION,
  runId: "00000000-0000-4000-8000-000000000001",
  provenance: {
    fileKey: "KEY123",
    nodeId: "0:1",
    version: "v1",
    fetchedAt: "2026-06-19T10:00:00.000Z",
  },
  screens: [],
  skippedScreens: [],
  integrityHash: "0".repeat(64),
  redactionSummary: {
    totalStringsScanned: 0,
    stringsRedacted: 0,
    patternsMatched: {},
  },
});

const validMetrics = (): Record<string, unknown> => ({
  reductionRatio: 0.4,
  screenCount: 2,
  renderCount: 1,
  designTokenCount: 3,
  augmentation: {
    deterministic: 4,
    modelAugmented: 1,
    modelAugmentedShare: 0.2,
  },
  navGraph: { screens: 2, transitions: 1 },
  a11y: { findings: 0 },
});

describe("validateFigmaSnapshotRecord", () => {
  it("accepts a minimal valid record", () => {
    expect(validateFigmaSnapshotRecord(validRecord())).toEqual({ ok: true, reason: undefined });
  });

  it.each([
    ["non-object record", null, "record is not an object"],
    [
      "wrong schema version",
      { ...validRecord(), figmaSnapshotSchemaVersion: 2 },
      "unexpected figmaSnapshotSchemaVersion (expected 1)",
    ],
    ["unknown top-level key", { ...validRecord(), token: "secret" }, "unknown record key: token"],
    [
      "missing screen arrays",
      { ...validRecord(), screens: undefined },
      "screens and skippedScreens must be arrays",
    ],
    [
      "invalid structuralScreens",
      { ...validRecord(), structuralScreens: {} },
      "structuralScreens must be an array",
    ],
    [
      "invalid artifactHashes type",
      { ...validRecord(), artifactHashes: [] },
      "artifactHashes must be an object",
    ],
    [
      "unknown artifact hash key",
      { ...validRecord(), artifactHashes: { screenshot: "x" } },
      "unknown artifactHashes key: screenshot",
    ],
    ["invalid metrics type", { ...validRecord(), metrics: [] }, "metrics must be an object"],
    [
      "unknown metrics key",
      { ...validRecord(), metrics: { ...validMetrics(), rawNames: 1 } },
      "metrics has unknown keys",
    ],
    [
      "missing required metric number",
      { ...validRecord(), metrics: { ...validMetrics(), renderCount: "1" } },
      "metrics.renderCount must be a number",
    ],
    [
      "invalid augmentation type",
      { ...validRecord(), metrics: { ...validMetrics(), augmentation: null } },
      "metrics.augmentation must be an object",
    ],
    [
      "unknown augmentation key",
      {
        ...validRecord(),
        metrics: {
          ...validMetrics(),
          augmentation: {
            deterministic: 4,
            modelAugmented: 1,
            modelAugmentedShare: 0.2,
            unknown: 1,
          },
        },
      },
      "metrics.augmentation has unknown keys",
    ],
    [
      "invalid navGraph number",
      { ...validRecord(), metrics: { ...validMetrics(), navGraph: { screens: 2 } } },
      "metrics.navGraph.transitions must be a number",
    ],
    [
      "invalid a11y type",
      { ...validRecord(), metrics: { ...validMetrics(), a11y: "none" } },
      "metrics.a11y must be an object",
    ],
  ])("rejects %s", (_label, record, reason) => {
    expect(validateFigmaSnapshotRecord(record)).toEqual({ ok: false, reason });
  });
});
