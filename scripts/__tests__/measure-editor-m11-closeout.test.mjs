import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  budgetDisposition,
  directoryBytes,
  EDITOR_M11_CLOSEOUT_LIMITS,
  measurementRefusalReason,
  percentile,
  runEditorM11CloseoutMeasurement,
  shouldFailBudget,
  summarizeSamples,
} from "../measure-editor-m11-closeout.mjs";

const HARNESS_URL = pathToFileURL(
  join(import.meta.dirname, "..", "measure-editor-m11-closeout.mjs"),
).href;

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
      historyCaptureRssPerRoot: true,
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
      historyCaptureRssPerRootBytes: 1,
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
    // #2626: the RSS row is named for the local-history capture it measures, so the old name must
    // not come back under a rename. Shape only — the value's meaning is covered by the two tests
    // below, which exercise the settling branches themselves.
    expect(typeof result.measurement.historyCaptureRssPerRootBytes).toBe("number");
    expect(result.measurement).not.toHaveProperty("rssPerAdditionalRootBytes");
  });

  // A controlled run enforces the RSS budget, so it must not proceed on an unsettled delta. Pure
  // over both inputs, because the interesting case is the one this process cannot reach on its own.
  it("refuses only the controlled run that cannot settle the heap", () => {
    expect(measurementRefusalReason(true, false)).toBe("gc-settling-required");
    expect(measurementRefusalReason(true, true)).toBeUndefined();
    expect(measurementRefusalReason(false, false)).toBeUndefined();
    expect(measurementRefusalReason(false, true)).toBeUndefined();
  });

  // The reported flag has to follow the real runtime, and this process can only ever be one of the
  // two. Asserting it against the same helper that produced it would prove the field is copied and
  // nothing else, so each branch is observed in a node started the corresponding way.
  it("reports gc settling from the runtime it actually ran in", () => {
    const probe = `import(${JSON.stringify(HARNESS_URL)}).then((harness) => {
      process.stdout.write(String(harness.gcSettlingAvailable()));
    });`;
    const observe = (nodeArgs) =>
      execFileSync(process.execPath, [...nodeArgs, "-e", probe], { encoding: "utf8" });
    expect(observe([])).toBe("false");
    expect(observe(["--expose-gc"])).toBe("true");
  });
});
