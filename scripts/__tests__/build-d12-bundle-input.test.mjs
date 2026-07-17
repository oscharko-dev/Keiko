import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertD12BundleMeasurementFingerprint,
  buildD12BundleInput,
  computeD12BundleMeasurementSha256,
  prepareProductionBundle,
  runD12BundleInputProducer,
} from "../build-d12-bundle-input.mjs";

const COMMIT = "6c3d061e6c3d061e6c3d061e6c3d061e6c3d061e";
const PRODUCER_COMMIT = "7c3d061e6c3d061e6c3d061e6c3d061e6c3d061e";
const SOURCE_TREE_SHA_256 = "b".repeat(64);
const MEASUREMENT_HARNESS_SHA_256 = "d".repeat(64);
const LOCKFILE_SHA_256 = "e".repeat(64);
const outputs = [];

function releaseEvidence() {
  return {
    b1: { firstLoadScriptCount: 14, monacoMarkersInFirstLoad: 0, ok: true },
    b2: {
      budgetBytes: 2_621_440,
      shipsTotalBytes: 1_180_213,
      loadedTotalBytes: 1_180_213,
      ok: true,
      shipsOk: true,
      loadedOk: true,
    },
    b3: {
      budgetBytes: 768_000,
      largestWorkerBytes: 106_160,
      largestWorkerLabel: "editor",
      largestLoadedWorkerBytes: 106_160,
      largestLoadedWorkerLabel: "editor",
      ok: true,
      shipsOk: true,
      loadedOk: true,
    },
  };
}

function ownCode() {
  return { fileCount: 71, totalGzipBytes: 100_629, ceilingBytes: 102_400, ok: true };
}

function runtime() {
  return {
    architecture: "x64",
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    osRelease: "6.8.0-test",
    platform: "linux",
    zlibVersion: "1.3.1",
  };
}

function bundleInput() {
  return buildD12BundleInput({
    commit: COMMIT,
    dependencyProvisioning: {
      args: ["ci", "--ignore-scripts"],
      command: "npm",
      lockfileSha256: LOCKFILE_SHA_256,
    },
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    releaseEvidence: releaseEvidence(),
    ownCode: ownCode(),
    producerCommit: PRODUCER_COMMIT,
    runtime: runtime(),
    sourceTreeSha256: SOURCE_TREE_SHA_256,
  });
}

function producerBindings() {
  return {
    computeLockfileSha256: () => LOCKFILE_SHA_256,
    computeMeasurementHarnessSha256: () => MEASUREMENT_HARNESS_SHA_256,
    computeSourceTreeSha256: () => SOURCE_TREE_SHA_256,
    getProducerCommit: () => PRODUCER_COMMIT,
    getRuntimeProvenance: () => runtime(),
  };
}

afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});

describe("D12 bundle input contract", () => {
  it("produces the exact minimal baseline/candidate shape consumed by the D12 builder", () => {
    const input = bundleInput();

    expect(input).toEqual({
      commit: COMMIT,
      dependencyProvisioning: {
        args: ["ci", "--ignore-scripts"],
        command: "npm",
        lockfileSha256: LOCKFILE_SHA_256,
      },
      measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
      measurementSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      producerCommit: PRODUCER_COMMIT,
      runtime: runtime(),
      sourceTreeSha256: SOURCE_TREE_SHA_256,
      b1: { monacoMarkersInFirstLoad: 0, ok: true },
      b2: { shipsTotalBytes: 1_180_213, ok: true },
      b3: { largestWorkerBytes: 106_160, ok: true },
      b10: {
        fileCount: 71,
        totalGzipBytes: 100_629,
        ceilingBytes: 102_400,
        ok: true,
      },
    });
    expect(() => assertD12BundleMeasurementFingerprint(input)).not.toThrow();
  });

  it.each([
    ["B1", (input) => (input.b1.monacoMarkersInFirstLoad += 1)],
    ["B2", (input) => (input.b2.shipsTotalBytes += 1)],
    ["B3", (input) => (input.b3.largestWorkerBytes += 1)],
    ["B10", (input) => (input.b10.totalGzipBytes += 1)],
    ["target commit", (input) => (input.commit = "f".repeat(40))],
    ["producer commit", (input) => (input.producerCommit = "f".repeat(40))],
    ["runtime", (input) => (input.runtime.zlibVersion = "1.3.2")],
    [
      "dependency lockfile",
      (input) => (input.dependencyProvisioning.lockfileSha256 = "f".repeat(64)),
    ],
  ])("rejects a changed %s measurement until its fingerprint is recomputed", (_label, mutate) => {
    const input = bundleInput();
    mutate(input);

    expect(() => assertD12BundleMeasurementFingerprint(input)).toThrow(
      /measurementSha256 does not match measurements and producer bindings/u,
    );
    input.measurementSha256 = computeD12BundleMeasurementSha256(input);
    expect(() => assertD12BundleMeasurementFingerprint(input)).not.toThrow();
  });
});

describe("runD12BundleInputProducer", () => {
  it("provisions exact locked dependencies before clean and either production build", () => {
    const root = join(tmpdir(), `keiko-d12-stale-dist-${String(process.pid)}-${Date.now()}`);
    const staleArtifact = join(root, "dist", "stale.js");
    outputs.push(root);
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(staleArtifact, "stale\n", "utf8");
    const calls = [];

    prepareProductionBundle(root, (command, args, options) => {
      calls.push({ args, command, options });
      if (args[1] === "clean") rmSync(join(root, "dist"), { recursive: true, force: true });
      if (args[1] === "build" && existsSync(staleArtifact)) {
        throw new Error("stale dist reached build");
      }
    });

    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["npm", "ci", "--ignore-scripts"],
      ["npm", "run", "clean"],
      ["npm", "run", "build"],
      ["npm", "run", "build:ui"],
    ]);
    expect(calls.every((call) => call.options.cwd === root)).toBe(true);
    expect(calls.every((call) => call.options.env.NODE_OPTIONS === undefined)).toBe(true);
    expect(calls.every((call) => call.options.shell === undefined)).toBe(true);
    expect(existsSync(staleArtifact)).toBe(false);
  });

  it("binds real measurements to an unchanged target checkout HEAD and writes deterministic JSON", () => {
    const outputDir = join(tmpdir(), `keiko-d12-bundle-${String(process.pid)}-${Date.now()}`);
    outputs.push(outputDir);
    const output = join(outputDir, "candidate", "bundle.json");
    const measuredRoots = [];
    const preparedRoots = [];

    const result = runD12BundleInputProducer(["--root", "/exact/checkout", "--output", output], {
      ...producerBindings(),
      getCheckoutCommit: () => COMMIT,
      listDirtyPaths: () => [],
      prepareProductionBundle: (root) => preparedRoots.push(root),
      measureReleaseEvidence: (root) => {
        measuredRoots.push(root);
        return releaseEvidence();
      },
      measureEditorOwnCode: (root) => {
        measuredRoots.push(root);
        return ownCode();
      },
    });

    expect(preparedRoots).toEqual(["/exact/checkout"]);
    expect(measuredRoots).toEqual(["/exact/checkout", "/exact/checkout"]);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result);
    expect(result.commit).toBe(COMMIT);
  });

  it("fails closed when the target checkout changes during measurement", () => {
    const otherCommit = "7c3d061e6c3d061e6c3d061e6c3d061e6c3d061e";
    let call = 0;

    expect(() =>
      runD12BundleInputProducer(["--output", join(tmpdir(), "unused-d12-bundle.json")], {
        ...producerBindings(),
        getCheckoutCommit: () => (call++ === 0 ? COMMIT : otherCommit),
        listDirtyPaths: () => [],
        prepareProductionBundle: () => undefined,
        measureReleaseEvidence: releaseEvidence,
        measureEditorOwnCode: ownCode,
      }),
    ).toThrow(/checkout HEAD changed during bundle measurement/u);
  });

  it("fails closed when the observed build runtime changes during measurement", () => {
    let call = 0;

    expect(() =>
      runD12BundleInputProducer(["--output", join(tmpdir(), "unused-d12-bundle.json")], {
        ...producerBindings(),
        getCheckoutCommit: () => COMMIT,
        getRuntimeProvenance: () => ({
          ...runtime(),
          zlibVersion: call++ === 0 ? "1.3.1" : "1.3.2",
        }),
        listDirtyPaths: () => [],
        prepareProductionBundle: () => undefined,
      }),
    ).toThrow(/bundle runtime changed during exact dependency provisioning or production build/u);
  });

  it("rejects a dirty target checkout before building or measuring", () => {
    let prepared = false;

    expect(() =>
      runD12BundleInputProducer(["--output", join(tmpdir(), "unused-d12-bundle.json")], {
        ...producerBindings(),
        getCheckoutCommit: () => COMMIT,
        listDirtyPaths: () => ["packages/keiko-editor/src/index.ts"],
        prepareProductionBundle: () => {
          prepared = true;
        },
      }),
    ).toThrow(/checkout is dirty/u);
    expect(prepared).toBe(false);
  });
});

describe("package command", () => {
  it("exposes the repository-supported producer interface", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.scripts["build:d12-bundle-input"]).toBe(
      "node scripts/build-d12-bundle-input.mjs",
    );
  });
});
