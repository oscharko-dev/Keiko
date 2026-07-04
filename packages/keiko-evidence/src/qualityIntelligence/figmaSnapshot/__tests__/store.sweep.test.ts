// GEN-PERF-PERSISTENCE-010 regression: the figma-snapshot store is constructed per HTTP request,
// so a per-instance `swept` flag re-ran sweepOrphanedSideDirs + enforceFigmaSnapshotRetention (each
// re-reading every record) on EVERY request. The fix keys the swept flag on a module-level Map by
// evidence dir with a time-based re-sweep interval. This proves that two operations on stores for
// the same evidence dir within the interval trigger at most ONE sweep pass, and that advancing the
// clock past the interval allows exactly one more.
//
// Mechanism proof: __figmaSnapshotSweepStats.sweeps increments once per ACTUAL sweep+retention pass
// (not per store instance). Pre-fix each per-request store swept once (so N stores => N sweeps);
// post-fix the count is bounded by the re-sweep interval.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __figmaSnapshotSweepStats,
  __resetFigmaSnapshotSweepRegistryForTests,
  createNodeFigmaSnapshotStore,
  type RecordFigmaSnapshotInput,
} from "../store.js";

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "figma-snapshot-sweep-"));
  __resetFigmaSnapshotSweepRegistryForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const node = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  type: "FRAME",
  interactionHint: "container",
  imageFills: [],
  children: [],
});

const baseInput = (): RecordFigmaSnapshotInput => ({
  runId: RUN_ID,
  provenance: {
    fileKey: "KEY123",
    nodeId: "0:1",
    version: "v-pinned-1",
    fetchedAt: "2026-07-03T00:00:00.000Z",
  },
  integrityHash: "0".repeat(64),
  screens: [
    {
      screenId: "1:1",
      irJson: { id: "1:1", name: "Home", root: node("1:1:root", "Home") },
      integrityHash: "b".repeat(64),
      image: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 1, 2]) },
    },
  ],
  skippedScreens: [],
});

describe("figma-snapshot module-level re-sweep (GEN-PERF-PERSISTENCE-010)", () => {
  it("sweeps at most once across many per-request stores within the interval", () => {
    // Seed one record so the side-file base dir exists; record() also performs the priming sweep.
    createNodeFigmaSnapshotStore(dir).record(baseInput());
    __resetFigmaSnapshotSweepRegistryForTests();

    let clock = 1_000_000;
    const now = (): number => clock;

    // 5 separate per-request stores, all within the 5-minute interval.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000; // +1s each, all << 5min
      createNodeFigmaSnapshotStore(dir, { now }).listRecent(4);
    }

    // At most ONE sweep pass despite 5 store instances. PRE-FIX this would be 5.
    expect(__figmaSnapshotSweepStats.sweeps).toBe(1);
  });

  it("re-sweeps once more after the clock advances past the interval", () => {
    createNodeFigmaSnapshotStore(dir).record(baseInput());
    __resetFigmaSnapshotSweepRegistryForTests();

    let clock = 2_000_000;
    const now = (): number => clock;

    createNodeFigmaSnapshotStore(dir, { now }).listRecent(4);
    expect(__figmaSnapshotSweepStats.sweeps).toBe(1);

    // Within interval: still no new sweep.
    clock += 60_000;
    createNodeFigmaSnapshotStore(dir, { now }).listRecent(4);
    expect(__figmaSnapshotSweepStats.sweeps).toBe(1);

    // Past the 5-minute interval: exactly one more sweep.
    clock += 5 * 60 * 1000 + 1;
    createNodeFigmaSnapshotStore(dir, { now }).listRecent(4);
    expect(__figmaSnapshotSweepStats.sweeps).toBe(2);
  });
});
