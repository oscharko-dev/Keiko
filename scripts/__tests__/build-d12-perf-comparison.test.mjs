import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { computeD12BundleMeasurementSha256 } from "../build-d12-bundle-input.mjs";
import {
  listExactDirtyPerformanceSubjectPaths,
  runD12Builder,
} from "../build-d12-perf-comparison.mjs";
import {
  computePerformanceSubjectDigest,
  evaluateEditorEvidence,
  evaluateFreshness,
} from "../check-perf-evidence.mjs";

const BASELINE_COMMIT = "bbda3c43c39fabe6c743b8be5d144abccd866397";
const CANDIDATE_COMMIT = "6c3d061e6c3d061e6c3d061e6c3d061e6c3d061e";
const BASELINE_SOURCE_TREE_SHA_256 = "a".repeat(64);
const SOURCE_TREE_SHA_256 = "b".repeat(64);
const MEASUREMENT_HARNESS_SHA_256 = "e".repeat(64);
const LOCKFILE_CONTENT = "{}\n";
const LOCKFILE_SHA_256 = createHash("sha256").update(LOCKFILE_CONTENT).digest("hex");
const RUN_BASE_MS = Date.parse("2026-07-15T12:00:00.000Z");
const roots = [];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function repeatedSamples(value, high = value) {
  return [...Array(9).fill(value), high];
}

function runTimestamp(sequence, offset) {
  return new Date(RUN_BASE_MS + (sequence * 6 - 6 + offset) * 1000).toISOString();
}

function rawEvidence(revision, index, sequence) {
  const candidate = revision === "candidate";
  const offset = index * 10;
  return {
    schemaVersion: "1",
    kind: "common",
    revision,
    commit: candidate ? CANDIDATE_COMMIT : BASELINE_COMMIT,
    measuredAtIso: runTimestamp(sequence, 1),
    sourceTreeSha256: candidate ? SOURCE_TREE_SHA_256 : BASELINE_SOURCE_TREE_SHA_256,
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    provenance: provenance(),
    b4ColdStartMs: {
      budgetP50: 1500,
      budgetP95: 2500,
      samples: repeatedSamples(1000 + offset + (candidate ? 40 : 0), 1200 + offset),
    },
    b5KeystrokeMs: {
      budgetMax: 50,
      captured: true,
      samples: repeatedSamples(0),
      longTaskCount: 0,
      maxLongTaskMs: 0,
    },
    ...(candidate
      ? {
          b5IdleDebugSession: {
            attempted: true,
            budgetMax: 50,
            captured: true,
            expectedSampleCount: 10,
            idleIntervalMs: 1100,
            processingSamples: repeatedSamples(12 + index),
            longTaskCount: 0,
            matchedInputEventCounts: Array(10).fill(1),
            maxLongTaskMs: 0,
            outputAcceptedBytes: 0,
            sessionStatus: "paused",
            totalMatchedInputEvents: 10,
            traceCaptured: true,
          },
        }
      : {
          d12BaselineMeasuredWork: {
            captured: true,
            expectedSampleCount: 10,
            processingSamples: repeatedSamples(8 + index),
            matchedInputEventCounts: Array(10).fill(1),
            longTaskCount: 0,
            maxLongTaskMs: 0,
            totalMatchedInputEvents: 10,
            traceCaptured: true,
          },
        }),
    b6InteractionMs: {
      budgetP75: 200,
      captured: true,
      samples: repeatedSamples(100 + index + (candidate ? 5 : 0)),
    },
    b11Memory: {
      supported: true,
      baselineBytes: 10_000_000 + offset,
      peakBytes: 20_000_000 + offset + (candidate ? 500_000 : 0),
      residualBytes: 11_000_000 + offset + (candidate ? 100_000 : 0),
      cycles: 2,
    },
    workerLoadCapture: {
      totalWorkerRequests: 1,
      editorWorkerLoaded: true,
      tsLanguageWorkerLoaded: false,
      languageWorkerLoaded: false,
    },
  };
}

function bundleEvidence(revision) {
  const candidate = revision === "candidate";
  const evidence = {
    commit: candidate ? CANDIDATE_COMMIT : BASELINE_COMMIT,
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    producerCommit: CANDIDATE_COMMIT,
    runtime: {
      architecture: "x64",
      nodeVersion: "24.18.0",
      npmVersion: "11.16.0",
      osRelease: "6.8.0-test",
      platform: "linux",
      zlibVersion: "1.3.1",
    },
    sourceTreeSha256: candidate ? SOURCE_TREE_SHA_256 : BASELINE_SOURCE_TREE_SHA_256,
    dependencyProvisioning: {
      args: ["ci", "--ignore-scripts"],
      command: "npm",
      lockfileSha256: LOCKFILE_SHA_256,
    },
    b1: { monacoMarkersInFirstLoad: 0, ok: true },
    b2: { shipsTotalBytes: candidate ? 1_010_000 : 1_000_000, ok: true },
    b3: { largestWorkerBytes: candidate ? 205_000 : 200_000, ok: true },
    b10: {
      totalGzipBytes: candidate ? 82_000 : 80_000,
      ceilingBytes: 102_400,
      fileCount: 10,
      ok: true,
    },
  };
  return {
    ...evidence,
    measurementSha256: computeD12BundleMeasurementSha256(evidence),
  };
}

function capEvidence(index, sequence) {
  return {
    schemaVersion: "1",
    kind: "cap",
    revision: "candidate",
    commit: CANDIDATE_COMMIT,
    measuredAtIso: runTimestamp(sequence, 4),
    sourceTreeSha256: SOURCE_TREE_SHA_256,
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    provenance: provenance(),
    stoppedProjection: {
      frames: 128,
      scopes: 32,
      variables: 200,
      depth: 4,
      nodes: 1_000,
      inlineDecorations: 200,
      samples: repeatedSamples(150 + index),
      maxLongTaskMs: 40,
    },
    outputFlood: {
      adapterOutputBytes: 1_048_576,
      limitMarkers: 1,
      retainedBytes: 524_288,
      retainedEntries: 2_000,
      renderedRows: 120,
      renderedRowsCeiling: 200,
      stopSamples: repeatedSamples(160 + index),
      maxLongTaskMs: 45,
      residualHeapBytes: 16_777_216,
    },
  };
}

function provenance() {
  return {
    platform: "linux",
    architecture: "x64",
    osRelease: "6.8.0-test",
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    lockfileSha256: LOCKFILE_SHA_256,
    playwrightVersion: "1.61.1",
    zlibVersion: "1.3.1",
    chromiumVersion: "140.0.7339.16",
    hardware: {
      cpuModel: "Keiko deterministic test CPU",
      logicalCores: 4,
      memoryBytes: 16 * 1024 * 1024 * 1024,
    },
  };
}

function artifactSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executionRecord(root, artifact, revision, sequence) {
  const commonCompletedAtIso = runTimestamp(sequence, 2);
  return {
    artifact,
    artifactSha256: artifactSha256(join(root, artifact)),
    checkoutHead: revision === "baseline" ? BASELINE_COMMIT : CANDIDATE_COMMIT,
    commonCompletedAtIso,
    completedAtIso: revision === "candidate" ? runTimestamp(sequence, 5) : commonCompletedAtIso,
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    provenance: provenance(),
    sequence,
    sourceTreeSha256: revision === "baseline" ? BASELINE_SOURCE_TREE_SHA_256 : SOURCE_TREE_SHA_256,
    startedAtIso: runTimestamp(sequence, 0),
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-d12-builder-"));
  roots.push(root);
  writeFileSync(join(root, "package-lock.json"), LOCKFILE_CONTENT, "utf8");
  const orders = [
    ["baseline", "candidate"],
    ["candidate", "baseline"],
    ["baseline", "candidate"],
  ];
  let sequence = 0;
  for (const [index, order] of orders.entries()) {
    let candidateSequence = 0;
    for (const revision of order) {
      sequence += 1;
      if (revision === "candidate") candidateSequence = sequence;
      writeJson(
        join(root, `${revision}-${String(index + 1)}.json`),
        rawEvidence(revision, index, sequence),
      );
    }
    writeJson(
      join(root, `candidate-cap-${String(index + 1)}.json`),
      capEvidence(index, candidateSequence),
    );
  }
  sequence = 0;
  const manifest = {
    schemaVersion: "3",
    dependencyProvisioning: {
      command: "npm",
      args: ["ci", "--ignore-scripts"],
      lockfileSha256: LOCKFILE_SHA_256,
    },
    warmUp: {
      runs: 1,
      procedure: "one complete unrecorded run per revision",
    },
    repetitions: orders.map((order, index) => {
      const entry = { order };
      for (const revision of order) {
        sequence += 1;
        const artifact = `${revision}-${String(index + 1)}.json`;
        entry[revision] = executionRecord(root, artifact, revision, sequence);
        if (revision === "candidate") {
          const capArtifact = `candidate-cap-${String(index + 1)}.json`;
          entry[revision].capEvidence = {
            artifact: capArtifact,
            artifactSha256: artifactSha256(join(root, capArtifact)),
            checkoutHead: CANDIDATE_COMMIT,
            completedAtIso: runTimestamp(sequence, 5),
            measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
            provenance: provenance(),
            sequence,
            sourceTreeSha256: SOURCE_TREE_SHA_256,
            startedAtIso: runTimestamp(sequence, 3),
          };
        }
      }
      return entry;
    }),
  };
  writeJson(join(root, "order.json"), manifest);
  writeJson(join(root, "baseline-bundle.json"), bundleEvidence("baseline"));
  writeJson(join(root, "candidate-bundle.json"), bundleEvidence("candidate"));
  return { root, manifest };
}

function invocation(root, selfCheck = false) {
  const args = [
    "--manifest",
    join(root, "order.json"),
    "--baseline-bundle",
    join(root, "baseline-bundle.json"),
    "--candidate-bundle",
    join(root, "candidate-bundle.json"),
    "--baseline-root",
    root,
    "--candidate-root",
    root,
    "--output",
    join(root, "d12-overlay.json"),
  ];
  if (selfCheck) args.push("--self-check");
  return args;
}

function run(root, overrides = {}) {
  let digestCalls = 0;
  let headCalls = 0;
  return runD12Builder(invocation(root, overrides.selfCheck), {
    computeDigest:
      overrides.computeDigest ??
      (() => (digestCalls++ === 0 ? BASELINE_SOURCE_TREE_SHA_256 : SOURCE_TREE_SHA_256)),
    getHead: overrides.getHead ?? (() => (headCalls++ === 0 ? BASELINE_COMMIT : CANDIDATE_COMMIT)),
    isAncestor: overrides.isAncestor ?? (() => true),
    listDirtyPaths: overrides.listDirtyPaths ?? (() => []),
    computeMeasurementHarnessSha256:
      overrides.computeMeasurementHarnessSha256 ?? (() => MEASUREMENT_HARNESS_SHA_256),
    computeBaselineDigest: overrides.computeBaselineDigest ?? (() => BASELINE_SOURCE_TREE_SHA_256),
    evaluateEditorEvidence: overrides.evaluateEditorEvidence,
    evaluateFreshness: overrides.evaluateFreshness,
  });
}

function mutateJson(root, name, mutate) {
  const path = join(root, name);
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeJson(path, value);
  if (/^(?:baseline|candidate)(?:-cap)?-\d+\.json$/u.test(name)) {
    const manifestPath = join(root, "order.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const repetition of manifest.repetitions) {
      for (const revision of ["baseline", "candidate"]) {
        if (repetition[revision].artifact === name) {
          repetition[revision].artifactSha256 = artifactSha256(path);
        }
        if (repetition[revision].capEvidence?.artifact === name) {
          repetition[revision].capEvidence.artifactSha256 = artifactSha256(path);
        }
      }
    }
    writeJson(manifestPath, manifest);
  }
}

function mutateAllProvenance(root, mutate) {
  for (const revision of ["baseline", "candidate"]) {
    mutateJson(root, `${revision}-bundle.json`, (value) => {
      const runtime = { ...value.runtime };
      mutate(runtime);
      value.runtime = Object.fromEntries(
        Object.keys(value.runtime).map((key) => [key, runtime[key]]),
      );
      value.measurementSha256 = computeD12BundleMeasurementSha256(value);
    });
  }
  for (const revision of ["baseline", "candidate"]) {
    for (let index = 1; index <= 3; index += 1) {
      mutateJson(root, `${revision}-${String(index)}.json`, (value) => mutate(value.provenance));
      if (revision === "candidate") {
        mutateJson(root, `candidate-cap-${String(index)}.json`, (value) =>
          mutate(value.provenance),
        );
      }
    }
  }
  mutateJson(root, "order.json", (manifest) => {
    for (const repetition of manifest.repetitions) {
      for (const revision of ["baseline", "candidate"]) mutate(repetition[revision].provenance);
      mutate(repetition.candidate.capEvidence.provenance);
    }
  });
}

function replaceRevisionSourceDigest(root, revision, digest) {
  mutateJson(root, `${revision}-bundle.json`, (value) => {
    value.sourceTreeSha256 = digest;
    value.measurementSha256 = computeD12BundleMeasurementSha256(value);
  });
  for (let index = 1; index <= 3; index += 1) {
    mutateJson(root, `${revision}-${String(index)}.json`, (value) => {
      value.sourceTreeSha256 = digest;
    });
  }
  if (revision === "candidate") {
    for (let index = 1; index <= 3; index += 1) {
      mutateJson(root, `candidate-cap-${String(index)}.json`, (value) => {
        value.sourceTreeSha256 = digest;
      });
    }
  }
  mutateJson(root, "order.json", (manifest) => {
    for (const repetition of manifest.repetitions) {
      repetition[revision].sourceTreeSha256 = digest;
      if (revision === "candidate") repetition[revision].capEvidence.sourceTreeSha256 = digest;
    }
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D12 performance comparison builder", () => {
  it("builds complete final editor evidence that passes budget and current-source freshness", () => {
    const { root } = createFixture();
    const computeMeasurementHarnessSha256 = vi.fn(() => MEASUREMENT_HARNESS_SHA_256);
    const output = run(root, { selfCheck: true, computeMeasurementHarnessSha256 });

    expect(output.commit).toBe(CANDIDATE_COMMIT);
    expect(computeMeasurementHarnessSha256).toHaveBeenCalledWith(root, CANDIDATE_COMMIT);
    expect(output.measuredAtIso).toBe("2026-07-15T12:00:31.000Z");
    expect(output.freshnessBinding).toBe("source-tree-v1");
    expect(output.sourceTreeSha256).toBe(SOURCE_TREE_SHA_256);
    expect(output.b4ColdStartMs).toEqual({
      budgetP50: 1500,
      budgetP95: 2500,
      p50: 1050,
      p95: 1210,
    });
    expect(output.b5KeystrokeMs).toEqual({
      budgetMax: 50,
      captured: true,
      longTaskCount: 0,
      maxLongTaskMs: 0,
    });
    expect(output.b5IdleDebugSession).toMatchObject({
      p95: 13,
      processingSamples: Array(10).fill(13),
      longTaskCount: 0,
      maxLongTaskMs: 0,
    });
    expect(output.b6InteractionMs).toEqual({ budgetP75: 200, captured: true, p75: 106 });
    expect(output.b11Memory).toEqual({
      supported: true,
      baselineBytes: 10_000_010,
      peakBytes: 20_500_010,
      residualBytes: 11_100_010,
      cycles: 2,
    });
    expect(output.workerLoadCapture).toEqual({
      totalWorkerRequests: 1,
      editorWorkerLoaded: true,
      tsLanguageWorkerLoaded: false,
      languageWorkerLoaded: false,
    });
    expect(output.d12Comparison.repetitions).toHaveLength(3);
    expect(output.d12Comparison.dependencyProvisioning).toEqual({
      command: "npm",
      args: ["ci", "--ignore-scripts"],
      lockfileSha256: LOCKFILE_SHA_256,
    });
    expect(output.d12Comparison.repetitions.map((item) => item.order)).toEqual([
      ["baseline", "candidate"],
      ["candidate", "baseline"],
      ["baseline", "candidate"],
    ]);
    expect(
      output.d12Comparison.repetitions.flatMap((repetition) =>
        repetition.order.map((revision) => repetition[revision].sequence),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(output.d12Comparison.repetitions[0].baseline).toMatchObject({
      sequence: 1,
      startedAtIso: "2026-07-15T12:00:00.000Z",
      commonCompletedAtIso: "2026-07-15T12:00:02.000Z",
      completedAtIso: "2026-07-15T12:00:02.000Z",
    });
    expect(output.d12Comparison.repetitions[0].candidate).toMatchObject({
      sequence: 2,
      startedAtIso: "2026-07-15T12:00:06.000Z",
      commonCompletedAtIso: "2026-07-15T12:00:08.000Z",
      completedAtIso: "2026-07-15T12:00:11.000Z",
    });
    expect(output.d12Comparison.repetitions[0].baseline.metrics.b5IdleDebug).toMatchObject({
      expectedSampleCount: 10,
      matchedInputEventCounts: Array(10).fill(1),
      totalMatchedInputEvents: 10,
      traceCaptured: true,
    });
    expect(output.d12Comparison.repetitions[0].candidate.metrics.b5IdleDebug).toMatchObject({
      expectedSampleCount: 10,
      matchedInputEventCounts: Array(10).fill(1),
      totalMatchedInputEvents: 10,
      traceCaptured: true,
    });
    expect(output.d12Comparison.repetitions[0].candidate.metrics.capScenarios).toMatchObject({
      sequence: 2,
      startedAtIso: "2026-07-15T12:00:09.000Z",
      completedAtIso: "2026-07-15T12:00:11.000Z",
      stoppedProjection: {
        frames: 128,
        scopes: 32,
        variables: 200,
        depth: 4,
        nodes: 1_000,
        inlineDecorations: 200,
        p75: 150,
      },
      outputFlood: {
        adapterOutputBytes: 1_048_576,
        limitMarkers: 1,
        retainedBytes: 524_288,
        retainedEntries: 2_000,
        renderedRows: 120,
        stopP75: 160,
        residualHeapBytes: 16_777_216,
      },
    });
    expect(output.d12Comparison.repetitions[0].baseline.rawInput).toMatchObject({
      schemaVersion: "2",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      artifact: {
        kind: "common",
        revision: "baseline",
      },
    });
    expect(
      output.d12Comparison.repetitions[0].candidate.metrics.capScenarios.rawInput,
    ).toMatchObject({
      schemaVersion: "2",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      artifact: {
        kind: "cap",
        revision: "candidate",
      },
    });
    expect(output.d12Comparison.aggregates.baseline).toMatchObject({
      b2Bytes: 1_000_000,
      b4P50Ms: 1010,
      b4P95Ms: 1210,
      b5IdleDebugP95Ms: 9,
      b6P75Ms: 101,
      b11PeakBytes: 20_000_010,
    });
    expect(output.d12Comparison.aggregates.candidate).toMatchObject({
      b2Bytes: 1_010_000,
      b4P50Ms: 1050,
      b4P95Ms: 1210,
      b5IdleDebugP95Ms: 13,
      b6P75Ms: 106,
      b11PeakBytes: 20_500_010,
    });
    expect(output.d12Comparison.deltas).toMatchObject({
      b2Bytes: 10_000,
      b4P50Ms: 40,
      b5IdleDebugP95Ms: 4,
      b6P75Ms: 5,
      b11PeakBytes: 500_000,
    });
    expect(evaluateEditorEvidence(output)).toEqual({ passed: true, failures: [] });
    expect(
      evaluateFreshness(output, {
        computeBaselineSourceTreeSha256: () => BASELINE_SOURCE_TREE_SHA_256,
        computeLockfileSha256: () => LOCKFILE_SHA_256,
        computeMeasurementHarnessSha256: () => MEASUREMENT_HARNESS_SHA_256,
        computeSourceTreeSha256: () => SOURCE_TREE_SHA_256,
        dirtySubjectPaths: [],
        isAncestor: () => true,
      }),
    ).toEqual({ passed: true, failures: [] });
    expect(JSON.parse(readFileSync(join(root, "d12-overlay.json"), "utf8"))).toEqual(output);
  });

  it("runs complete editor and current-source freshness evaluators during self-check", () => {
    const { root } = createFixture();
    const editorEvaluator = vi.fn(() => ({ passed: true, failures: [] }));
    const freshnessEvaluator = vi.fn(() => ({ passed: true, failures: [] }));

    const output = run(root, {
      selfCheck: true,
      evaluateEditorEvidence: editorEvaluator,
      evaluateFreshness: freshnessEvaluator,
    });

    expect(editorEvaluator).toHaveBeenCalledWith(output);
    expect(freshnessEvaluator).toHaveBeenCalledWith(
      output,
      expect.objectContaining({
        computeMeasurementHarnessSha256: expect.any(Function),
        computeSourceTreeSha256: expect.any(Function),
        dirtySubjectPaths: [],
        isAncestor: expect.any(Function),
      }),
    );
  });

  it("rejects a mutated bundle value whose measurement fingerprint is stale", () => {
    const { root } = createFixture();
    mutateJson(root, "candidate-bundle.json", (value) => {
      value.b2.shipsTotalBytes += 1;
    });

    expect(() => run(root)).toThrow(/measurement(?:Sha256| fingerprint)/iu);
    expect(existsSync(join(root, "d12-overlay.json"))).toBe(false);
  });

  it.each([
    ["foreign producer", (value) => (value.producerCommit = "9".repeat(40)), /bundle producer/u],
    [
      "source-tree drift",
      (value) => (value.sourceTreeSha256 = "9".repeat(64)),
      /bundle sourceTreeSha256/u,
    ],
    [
      "measurement-toolchain drift",
      (value) => (value.measurementHarnessSha256 = "9".repeat(64)),
      /bundle measurementHarnessSha256/u,
    ],
    [
      "bundle runtime drift",
      (value) => (value.runtime.zlibVersion = "1.3.2"),
      /bundle runtime differs from the common browser provenance/u,
    ],
  ])("rejects %s even with a recomputed bundle fingerprint", (_label, mutate, expected) => {
    const { root } = createFixture();
    mutateJson(root, "baseline-bundle.json", (value) => {
      mutate(value);
      value.measurementSha256 = computeD12BundleMeasurementSha256(value);
    });

    expect(() => run(root)).toThrow(expected);
  });

  it("uses the shared performance-subject digest shape without leaking raw content", () => {
    const { root } = createFixture();
    const sharedDigest = computePerformanceSubjectDigest({
      trackedPaths: ["src/example.ts"],
      readTrackedFile: () => Buffer.from("export const measured = true;\n", "utf8"),
    });
    replaceRevisionSourceDigest(root, "candidate", sharedDigest);
    let calls = 0;
    const output = run(root, {
      computeDigest: () => (calls++ === 0 ? BASELINE_SOURCE_TREE_SHA_256 : sharedDigest),
    });
    const serialized = JSON.stringify(output);

    expect(output.sourceTreeSha256).toBe(sharedDigest);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("secret.invalid");
    expect(serialized).not.toContain("editorRuntimeChunks");
  });

  it("rejects an allowlist-escaping raw artifact even when its manifest digest is refreshed", () => {
    const { root } = createFixture();
    mutateJson(root, "candidate-1.json", (value) => {
      value.unredactedBody = "forbidden";
    });

    expect(() => run(root)).toThrow(/non-canonical|unknown field/u);
  });

  it.each([
    ["missing raw commit", "candidate-2.json", (value) => delete value.commit, /candidate commit/u],
    [
      "mismatched raw commit",
      "baseline-3.json",
      (value) => (value.commit = CANDIDATE_COMMIT),
      /does not match/u,
    ],
    [
      "mismatched bundle commit",
      "candidate-bundle.json",
      (value) => (value.commit = BASELINE_COMMIT),
      /does not match/u,
    ],
  ])("rejects %s before writing", (_name, file, mutate, expected) => {
    const { root } = createFixture();
    mutateJson(root, file, mutate);
    expect(() => run(root)).toThrow(expected);
    expect(existsSync(join(root, "d12-overlay.json"))).toBe(false);
  });

  it.each([
    ["non-Linux provenance", (value) => (value.platform = "darwin"), /must be linux/u],
    ["Node.js drift", (value) => (value.nodeVersion = "24.17.0"), /must be 24\.18\.0/u],
    ["npm drift", (value) => (value.npmVersion = "11.15.0"), /must be 11\.16\.0/u],
    ["missing zlib identity", (value) => (value.zlibVersion = ""), /zlibVersion/u],
    [
      "lockfile drift",
      (value) => (value.lockfileSha256 = "invalid"),
      /lockfile(?:Sha256| digest)/u,
    ],
  ])("rejects %s", (_name, mutate, expected) => {
    const { root } = createFixture();
    mutateAllProvenance(root, mutate);
    expect(() => run(root)).toThrow(expected);
  });

  it("rejects invalid warm-up metadata", () => {
    const { root } = createFixture();
    mutateJson(root, "order.json", (value) => {
      value.warmUp.runs = 0;
    });
    expect(() => run(root)).toThrow(/warm-up runs/u);
  });

  it.each([
    ["command", (value) => (value.dependencyProvisioning.command = "pnpm"), /command must be npm/u],
    [
      "arguments",
      (value) => (value.dependencyProvisioning.args = ["install"]),
      /arguments must equal npm ci --ignore-scripts/u,
    ],
    [
      "lockfile digest",
      (value) => (value.dependencyProvisioning.lockfileSha256 = "invalid"),
      /lockfileSha256/u,
    ],
  ])("rejects invalid dependency provisioning %s", (_name, mutate, expected) => {
    const { root } = createFixture();
    mutateJson(root, "order.json", mutate);
    expect(() => run(root)).toThrow(expected);
  });

  it("rejects measured provenance from a different lockfile than the provisioned tree", () => {
    const { root } = createFixture();
    mutateAllProvenance(root, (value) => {
      value.lockfileSha256 = "f".repeat(64);
    });

    expect(() => run(root)).toThrow(/lockfile digest differs from measured provenance/u);
  });

  it("rejects internally consistent evidence provisioned from a stale current package-lock", () => {
    const { root } = createFixture();
    const staleDigest = "f".repeat(64);
    mutateAllProvenance(root, (value) => {
      value.lockfileSha256 = staleDigest;
    });
    mutateJson(root, "order.json", (value) => {
      value.dependencyProvisioning.lockfileSha256 = staleDigest;
    });

    expect(() => run(root)).toThrow(/current package-lock\.json/u);
  });

  it("preserves fractional nearest-rank cap percentiles without producer/checker rounding drift", () => {
    const { root } = createFixture();
    const stoppedSamples = [101.1, 102.2, 103.3, 104.4, 105.5, 106.6, 107.7, 108.8, 109.9, 110.1];
    const stopSamples = [111.1, 112.2, 113.3, 114.4, 115.5, 116.6, 117.7, 118.8, 119.9, 120.1];
    mutateJson(root, "candidate-cap-1.json", (value) => {
      value.stoppedProjection.samples = stoppedSamples;
      value.outputFlood.stopSamples = stopSamples;
    });

    const output = run(root, { selfCheck: true });
    const cap = output.d12Comparison.repetitions[0].candidate.metrics.capScenarios;
    expect(cap.stoppedProjection.p75).toBe(108.8);
    expect(cap.outputFlood.stopP75).toBe(118.8);
  });

  it.each([
    [
      "under-sampled B4",
      "baseline-1.json",
      (value) => (value.b4ColdStartMs.samples = [1, 2, 3]),
      /at least 10 raw samples/u,
    ],
    [
      "zero-valued B4 duration",
      "baseline-1.json",
      (value) => (value.b4ColdStartMs.samples[0] = 0),
      /B4 contains a non-positive or invalid sample/u,
    ],
    [
      "missing baseline measured work",
      "baseline-2.json",
      (value) => (value.d12BaselineMeasuredWork.processingSamples = []),
      /baseline measured-work B5 requires/u,
    ],
    [
      "zero-valued baseline measured work",
      "baseline-2.json",
      (value) => (value.d12BaselineMeasuredWork.processingSamples[0] = 0),
      /baseline measured-work B5 contains a non-positive or invalid sample/u,
    ],
    [
      "missing candidate idle-debug samples",
      "candidate-3.json",
      (value) => (value.b5IdleDebugSession.processingSamples = []),
      /candidate idle-debug B5 requires/u,
    ],
    [
      "zero-valued candidate idle-debug work",
      "candidate-3.json",
      (value) => (value.b5IdleDebugSession.processingSamples[0] = 0),
      /candidate idle-debug B5 contains a non-positive or invalid sample/u,
    ],
    [
      "missing B6 raw samples",
      "candidate-1.json",
      (value) => delete value.b6InteractionMs.samples,
      /B6 requires/u,
    ],
    [
      "zero-valued B6 duration",
      "candidate-1.json",
      (value) => (value.b6InteractionMs.samples[0] = 0),
      /B6 contains a non-positive or invalid sample/u,
    ],
    [
      "negative B5 keystroke long-task sample",
      "candidate-1.json",
      (value) => (value.b5KeystrokeMs.samples[0] = -1),
      /B5 keystroke: raw samples contain a negative or invalid measurement/u,
    ],
  ])("rejects %s", (_name, file, mutate, expected) => {
    const { root } = createFixture();
    mutateJson(root, file, mutate);
    expect(() => run(root)).toThrow(expected);
  });

  it.each([
    [
      "fractional B10 bytes",
      "baseline-bundle.json",
      (value) => {
        value.b10.totalGzipBytes = 1.5;
        value.measurementSha256 = computeD12BundleMeasurementSha256(value);
      },
      /B10 bytes/u,
    ],
    [
      "negative B2 bytes",
      "candidate-bundle.json",
      (value) => {
        value.b2.shipsTotalBytes = -1;
        value.measurementSha256 = computeD12BundleMeasurementSha256(value);
      },
      /B2 bytes/u,
    ],
    [
      "negative memory bytes",
      "candidate-2.json",
      (value) => (value.b11Memory.residualBytes = -1),
      /residualBytes/u,
    ],
    [
      "peak below baseline",
      "baseline-1.json",
      (value) => (value.b11Memory.peakBytes = 1),
      /below baselineBytes/u,
    ],
  ])("rejects %s", (_name, file, mutate, expected) => {
    const { root } = createFixture();
    mutateJson(root, file, mutate);
    expect(() => run(root)).toThrow(expected);
  });

  it("rejects a non-alternating actual order manifest", () => {
    const { root } = createFixture();
    mutateJson(root, "order.json", (value) => {
      value.repetitions[1].order = ["baseline", "candidate"];
    });
    expect(() => run(root)).toThrow(/does not alternate/u);
  });

  it("rejects fewer than three paired repetitions", () => {
    const { root } = createFixture();
    mutateJson(root, "order.json", (value) => {
      value.repetitions.pop();
    });
    expect(() => run(root)).toThrow(/exactly three paired repetitions/u);
  });

  it("rejects path aliases that reuse one raw input", () => {
    const { root } = createFixture();
    mutateJson(root, "order.json", (value) => {
      value.repetitions[1].baseline.artifact = "./baseline-1.json";
    });
    expect(() => run(root)).toThrow(/reuses raw input/u);
  });

  it("rejects raw input paths outside the manifest directory", () => {
    const { root } = createFixture();
    mutateJson(root, "order.json", (value) => {
      value.repetitions[1].baseline.artifact = "../outside.json";
    });
    expect(() => run(root)).toThrow(/escapes the order manifest directory/u);
  });

  it("rejects candidate idle-debug evidence that accepted visible output", () => {
    const { root } = createFixture();
    mutateJson(root, "candidate-1.json", (value) => {
      value.b5IdleDebugSession.outputAcceptedBytes = 1;
    });
    expect(() => run(root)).toThrow(/accepted visible output/u);
  });

  it("rejects a raw artifact whose bytes no longer match the recorded SHA-256", () => {
    const { root } = createFixture();
    writeFileSync(join(root, "candidate-1.json"), "{}\n", "utf8");
    expect(() => run(root)).toThrow(/artifactSha256 does not match/u);
    expect(existsSync(join(root, "d12-overlay.json"))).toBe(false);
  });

  it("rejects execution sequence or timing that cannot prove actual alternating order", () => {
    const { root } = createFixture();
    mutateJson(root, "order.json", (value) => {
      value.repetitions[1].candidate.sequence = 4;
    });
    expect(() => run(root)).toThrow(/sequence does not match actual order/u);

    const second = createFixture().root;
    mutateJson(second, "order.json", (value) => {
      value.repetitions[0].candidate.startedAtIso = value.repetitions[0].baseline.startedAtIso;
    });
    expect(() => run(second)).toThrow(/overlaps or precedes/u);
  });

  it("rejects candidate cap evidence outside the sequenced post-common interval", () => {
    const { root } = createFixture();
    mutateJson(root, "order.json", (value) => {
      value.repetitions[0].candidate.capEvidence.startedAtIso =
        value.repetitions[0].candidate.startedAtIso;
    });
    expect(() => run(root)).toThrow(/started before the common measurement completed/u);

    const second = createFixture().root;
    mutateJson(second, "candidate-cap-1.json", (value) => {
      value.measuredAtIso = "2026-07-15T12:00:00.000Z";
    });
    expect(() => run(second)).toThrow(/cap evidence measuredAtIso falls outside/u);
  });

  it("rejects per-run harness or provenance drift even when artifact and record agree", () => {
    const { root } = createFixture();
    mutateJson(root, "candidate-1.json", (value) => {
      value.measurementHarnessSha256 = "f".repeat(64);
    });
    mutateJson(root, "order.json", (value) => {
      value.repetitions[0].candidate.measurementHarnessSha256 = "f".repeat(64);
    });
    expect(() => run(root)).toThrow(/measurement harness digest differs/u);

    const second = createFixture().root;
    mutateJson(second, "candidate-1.json", (value) => {
      value.provenance.chromiumVersion = "different";
    });
    mutateJson(second, "order.json", (value) => {
      value.repetitions[0].candidate.provenance.chromiumVersion = "different";
    });
    expect(() => run(second)).toThrow(/provenance differs/u);
  });

  it("rejects candidate checkout HEAD drift and raw source-tree stamp drift", () => {
    const { root } = createFixture();
    for (const revision of ["baseline", "candidate"]) {
      mutateJson(root, `${revision}-bundle.json`, (value) => {
        value.producerCommit = "7".repeat(40);
        if (revision === "candidate") value.commit = "7".repeat(40);
        value.measurementSha256 = computeD12BundleMeasurementSha256(value);
      });
    }
    let calls = 0;
    expect(() =>
      run(root, {
        getHead: () => (calls++ === 0 ? BASELINE_COMMIT : "7".repeat(40)),
      }),
    ).toThrow(/candidate checkout HEAD does not match live HEAD/u);

    const second = createFixture().root;
    mutateJson(second, "candidate-1.json", (value) => {
      value.sourceTreeSha256 = "9".repeat(64);
    });
    expect(() => run(second)).toThrow(/sourceTreeSha256 does not match its execution record/u);
  });

  it("rejects generation when the pinned baseline is not an ancestor of candidate HEAD", () => {
    const { root } = createFixture();
    expect(() => run(root, { isAncestor: () => false })).toThrow(
      /pinned baseline commit is not an ancestor/u,
    );
    expect(existsSync(join(root, "d12-overlay.json"))).toBe(false);
  });

  it.each([
    ["stopped frames", (value) => (value.stoppedProjection.frames = 127), /frames must equal 128/u],
    [
      "stopped samples",
      (value) => (value.stoppedProjection.samples = [1]),
      /fewer than KEIKO_PERF_RUNS/u,
    ],
    [
      "stopped p75",
      (value) => {
        value.stoppedProjection.samples = repeatedSamples(201);
      },
      /p75 201ms > budget 200ms/u,
    ],
    [
      "output bytes",
      (value) => (value.outputFlood.adapterOutputBytes = 1_048_575),
      /adapterOutputBytes/u,
    ],
    ["limit marker", (value) => (value.outputFlood.limitMarkers = 2), /limitMarkers must equal 1/u],
    ["retained bytes", (value) => (value.outputFlood.retainedBytes = 524_289), /retainedBytes/u],
    [
      "retained entries",
      (value) => (value.outputFlood.retainedEntries = 2_001),
      /retainedEntries/u,
    ],
    ["rendered rows", (value) => (value.outputFlood.renderedRows = 201), /renderedRows exceeds/u],
    [
      "stop samples",
      (value) => (value.outputFlood.stopSamples = [1]),
      /stop: raw samples are missing or fewer than KEIKO_PERF_RUNS/u,
    ],
    [
      "stop p75",
      (value) => {
        value.outputFlood.stopSamples = repeatedSamples(201);
      },
      /stop: p75 201ms > budget 200ms/u,
    ],
    [
      "residual heap",
      (value) => (value.outputFlood.residualHeapBytes = 16_777_217),
      /residualHeapBytes/u,
    ],
  ])("rejects candidate cap evidence with invalid %s", (_name, mutate, expected) => {
    const { root } = createFixture();
    mutateJson(root, "candidate-cap-2.json", mutate);
    expect(() => run(root, { selfCheck: true })).toThrow(expected);
    expect(existsSync(join(root, "d12-overlay.json"))).toBe(false);
  });

  it("rejects dirty candidate subject inputs without overwriting an existing output", () => {
    const { root } = createFixture();
    const outputPath = join(root, "d12-overlay.json");
    writeFileSync(outputPath, "retained\n", "utf8");

    let calls = 0;
    expect(() =>
      run(root, {
        listDirtyPaths: () => (calls++ === 0 ? [] : ["packages/keiko-ui/src/example.ts"]),
      }),
    ).toThrow(/candidate performance subject is dirty/u);
    expect(readFileSync(outputPath, "utf8")).toBe("retained\n");
  });

  it("rejects an invalid digest returned by the shared helper", () => {
    const { root } = createFixture();
    expect(() => run(root, { computeDigest: () => "invalid" })).toThrow(/invalid baseline digest/u);
    expect(existsSync(join(root, "d12-overlay.json"))).toBe(false);
  });

  it("includes untracked performance-subject paths in exact clean-HEAD checks", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-d12-clean-head-"));
    roots.push(root);
    writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "package-lock.json"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Keiko Test",
        "-c",
        "user.email=test@invalid",
        "commit",
        "-m",
        "fixture",
        "--quiet",
      ],
      { cwd: root },
    );
    mkdirSync(join(root, "packages", "keiko-ui", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "keiko-ui", "src", "untracked.ts"),
      "export {};\n",
      "utf8",
    );
    writeFileSync(
      join(root, "packages", "keiko-ui", "src", "untracked.spec.ts"),
      "export {};\n",
      "utf8",
    );

    expect(listExactDirtyPerformanceSubjectPaths(root)).toEqual([
      "packages/keiko-ui/src/untracked.ts",
    ]);
  });

  it("rejects validator self-check failures before writing", () => {
    const { root } = createFixture();
    mutateJson(root, "candidate-2.json", (value) => {
      value.b5IdleDebugSession.longTaskCount = 1;
    });

    expect(() => run(root, { selfCheck: true })).toThrow(/validator self-check failed/u);
    expect(existsSync(join(root, "d12-overlay.json"))).toBe(false);
  });

  it.each([
    ["unknown option", ["--unknown", "value"], /unexpected argument --unknown/u],
    ["inline option syntax", ["--output=bad"], /unexpected argument --output=bad/u],
    ["positional argument", ["positional"], /unexpected argument positional/u],
  ])("rejects %s", (_name, extra, expected) => {
    const { root } = createFixture();
    expect(() => runD12Builder([...invocation(root), ...extra])).toThrow(expected);
  });

  it.each([
    ["value option", ["--output", "second.json"], /duplicate option --output/u],
    ["flag option", ["--self-check", "--self-check"], /duplicate option --self-check/u],
  ])("rejects a duplicate %s", (_name, extra, expected) => {
    const { root } = createFixture();
    expect(() => runD12Builder([...invocation(root), ...extra])).toThrow(expected);
  });

  it.each([
    ["missing value", ["--output"], /--output requires a value/u],
    ["option-shaped value", ["--output", "--manifest"], /--output requires a value/u],
    ["short-option value", ["--output", "-malformed"], /--output requires a value/u],
  ])("rejects a malformed %s", (_name, extra, expected) => {
    expect(() => runD12Builder(extra)).toThrow(expected);
  });
});
