import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  budgetDisposition,
  directoryBytes,
  EDITOR_M11_CLOSEOUT_LIMITS,
  percentile,
  runEditorM11CloseoutMeasurement,
  shouldFailBudget,
  summarizeSamples,
} from "../measure-editor-m11-closeout.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("editor M11 closeout measurement", () => {
  it("summarizes bounded p50, p95, and maximum samples", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(summarizeSamples([5, 1, 3, 2, 4])).toEqual({
      count: 5,
      p50Ms: 3,
      p95Ms: 5,
      maxMs: 5,
    });
  });

  it("measures nested history bytes and treats a missing directory as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-editor-m11-disk-test-"));
    roots.push(root);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "first"), "12345", "utf8");
    await writeFile(join(root, "nested", "second"), "1234567", "utf8");
    expect(await directoryBytes(root)).toBe(12);
    expect(await directoryBytes(join(root, "missing"))).toBe(0);
  });

  it("keeps deterministic bounds enforced outside controlled timing contexts", () => {
    const passing = {
      rootCount: true,
      rootProjectionP95: true,
      searchFanoutP95: true,
      editorSessionRoundTripP95: true,
      historyPruneP95: true,
      rssPerAdditionalRoot: true,
      historyDisk: true,
      retainedHistoryVersions: true,
    };
    expect(shouldFailBudget(passing, false)).toBe(false);
    expect(shouldFailBudget({ ...passing, historyDisk: false }, false)).toBe(true);
    expect(shouldFailBudget({ ...passing, rootProjectionP95: false }, false)).toBe(false);
    expect(shouldFailBudget({ ...passing, rootProjectionP95: false }, true)).toBe(true);
  });

  it("reports every performance and retention budget independently", () => {
    const measurement = {
      rootCount: 32,
      rootProjection: { p95Ms: 1 },
      searchFanout: { p95Ms: 1 },
      editorSessionRoundTrip: { p95Ms: 1 },
      historyPrune: { p95Ms: 1 },
      rssPerAdditionalRootBytes: 1,
      historyDiskBytes: 1,
      retainedHistoryVersions: 50,
    };
    expect(Object.values(budgetDisposition(measurement)).every(Boolean)).toBe(true);
    expect(
      budgetDisposition({
        ...measurement,
        historyPrune: { p95Ms: EDITOR_M11_CLOSEOUT_LIMITS.historyPruneP95Ms + 1 },
        retainedHistoryVersions: 49,
      }),
    ).toMatchObject({ historyPruneP95: false, retainedHistoryVersions: false });
  });

  it("measures the maximum root model and a pruned local-history chain", async () => {
    const result = await runEditorM11CloseoutMeasurement({ samples: 2, controlled: false });
    expect(result.measurementMode).toBe("informational-local");
    expect(result.measurement.rootCount).toBe(32);
    expect(result.measurement.retainedHistoryVersions).toBe(50);
    expect(result.historyChainLength).toBe(64);
    expect(result.historyRootCount).toBe(8);
    expect(result.passed).toBe(true);
  });
});
