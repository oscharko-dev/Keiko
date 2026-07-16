import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeD12ArtifactSha256,
  computeD12BundleMeasurementSha256,
  computeD12RawInputSha256,
  computePerformanceSubjectDigest,
  evaluateD12Comparison,
  evaluateEditorEvidence,
  evaluateFreshness,
  evaluateWorkspaceEvidence,
  isPerformanceSubjectPath,
  listDirtyPerformanceSubjectPaths,
  readEvidence,
} from "../check-perf-evidence.mjs";

const BASELINE_COMMIT = "bbda3c43c39fabe6c743b8be5d144abccd866397";
const CANDIDATE_COMMIT = "6c3d061e6c3d061e6c3d061e6c3d061e6c3d061e";
const SOURCE_TREE_SHA_256 = "b".repeat(64);
const BASELINE_SOURCE_TREE_SHA_256 = "c".repeat(64);
const MEASUREMENT_HARNESS_SHA_256 = "d".repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function performanceSubjectDigest(files, trackedPaths = Object.keys(files)) {
  return computePerformanceSubjectDigest({
    trackedPaths,
    readTrackedFile: (path) => Buffer.from(files[path] ?? "", "utf8"),
  });
}

function withTemporaryGitRepository(callback) {
  const root = mkdtempSync(join(tmpdir(), "keiko-perf-evidence-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n", "utf8");
    writeFileSync(join(root, "package.json"), "{}\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "package.json"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Keiko Test",
        "-c",
        "user.email=keiko-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "test fixture",
      ],
      { cwd: root },
    );
    callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function workspaceGesture(overrides = {}) {
  return {
    label: "workspace pan",
    frameGapBudgetP75Ms: 34,
    frameGapBudgetMaxMs: 120,
    frameGapSamples: 72,
    frameGapP75Ms: 8,
    frameGapMaxMs: 17,
    longTaskObserverInstalled: true,
    longTaskCount: 0,
    maxLongTaskMs: 0,
    viewWrites: 1,
    workspaceWrites: 0,
    workspacePuts: 0,
    ...overrides,
  };
}

function workspaceEvidence(gestureOverrides = {}) {
  return {
    measuredAtIso: "2026-07-03T12:00:00.000Z",
    commit: "6c3d061e",
    sourceTreeSha256: SOURCE_TREE_SHA_256,
    runs: {
      chromium: {
        project: "chromium",
        windowCount: 12,
        gestures: [workspaceGesture(gestureOverrides)],
      },
    },
  };
}

function idleDebugEvidence(overrides = {}) {
  return {
    attempted: true,
    budgetMax: 50,
    captured: true,
    expectedSampleCount: 3,
    idleIntervalMs: 500,
    longTaskCount: 0,
    matchedInputEventCounts: [2, 1, 3],
    maxLongTaskMs: 0,
    outputAcceptedBytes: 0,
    p95: 6,
    processingSamples: [4, 6, 5],
    sessionStatus: "paused",
    totalMatchedInputEvents: 6,
    traceCaptured: true,
    ...overrides,
  };
}

function d12Provenance() {
  return {
    platform: "linux",
    architecture: "x64",
    osRelease: "6.8.0-test",
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    lockfileSha256: "a".repeat(64),
    playwrightVersion: "1.55.0",
    zlibVersion: "1.3.1",
    chromiumVersion: "140.0.7339.16",
    hardware: {
      cpuModel: "Keiko deterministic test CPU",
      logicalCores: 4,
      memoryBytes: 16 * 1024 * 1024 * 1024,
    },
    warmUp: { runs: 1, procedure: "discard one complete suite run" },
  };
}

const D12_VALUES = {
  baseline: {
    commit: BASELINE_COMMIT,
    scenario: "baseline-editor",
    b2: 1_000_000,
    b3: 200_000,
    b10: 80_000,
    b4P50: 1000,
    b4P95: 1200,
    b5P95: 10,
    b6P75: 100,
    b11Baseline: 10_000_000,
    b11Peak: 20_000_000,
    b11Residual: 11_000_000,
    traceCaptured: true,
    outputAcceptedBytes: 0,
    sessionStatus: "none",
  },
  candidate: {
    commit: CANDIDATE_COMMIT,
    scenario: "idle-debug-session",
    b2: 1_010_000,
    b3: 205_000,
    b10: 82_000,
    b4P50: 1050,
    b4P95: 1250,
    b5P95: 12,
    b6P75: 109,
    b11Baseline: 12_000_000,
    b11Peak: 23_000_000,
    b11Residual: 13_000_000,
    traceCaptured: true,
    outputAcceptedBytes: 0,
    sessionStatus: "paused",
  },
};

function d12Timestamp(sequence, offset) {
  return new Date(
    Date.parse("2026-07-15T12:00:00.000Z") + (sequence * 10 + offset) * 1_000,
  ).toISOString();
}

function d12RawInput(artifact) {
  return { artifact, schemaVersion: "2", sha256: computeD12RawInputSha256(artifact) };
}

function rehashRawInput(rawInput) {
  rawInput.sha256 = computeD12RawInputSha256(rawInput.artifact);
}

function rawD12Provenance(provenance = d12Provenance()) {
  const raw = clone(provenance);
  delete raw.warmUp;
  return raw;
}

function d12CapScenarios(sequence) {
  const cap = {
    artifactSha256: "",
    commit: CANDIDATE_COMMIT,
    measuredAtIso: d12Timestamp(sequence, 3),
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    sequence,
    sourceTreeSha256: SOURCE_TREE_SHA_256,
    startedAtIso: d12Timestamp(sequence, 2),
    completedAtIso: d12Timestamp(sequence, 4),
    stoppedProjection: {
      depth: 4,
      frames: 128,
      inlineDecorations: 200,
      maxLongTaskMs: 40,
      nodes: 1_000,
      p75: 150,
      samples: Array(10).fill(150),
      scopes: 32,
      variables: 200,
    },
    outputFlood: {
      adapterOutputBytes: 1_048_576,
      limitMarkers: 1,
      maxLongTaskMs: 45,
      renderedRows: 120,
      renderedRowsCeiling: 200,
      residualHeapBytes: 16_777_216,
      retainedBytes: 524_288,
      retainedEntries: 2_000,
      stopP75: 160,
      stopSamples: Array(10).fill(160),
    },
  };
  const artifact = {
    schemaVersion: "1",
    kind: "cap",
    revision: "candidate",
    commit: cap.commit,
    measuredAtIso: cap.measuredAtIso,
    measurementHarnessSha256: cap.measurementHarnessSha256,
    outputFlood: {
      adapterOutputBytes: cap.outputFlood.adapterOutputBytes,
      limitMarkers: cap.outputFlood.limitMarkers,
      maxLongTaskMs: cap.outputFlood.maxLongTaskMs,
      renderedRows: cap.outputFlood.renderedRows,
      renderedRowsCeiling: cap.outputFlood.renderedRowsCeiling,
      residualHeapBytes: cap.outputFlood.residualHeapBytes,
      retainedBytes: cap.outputFlood.retainedBytes,
      retainedEntries: cap.outputFlood.retainedEntries,
      stopSamples: [...cap.outputFlood.stopSamples],
    },
    provenance: rawD12Provenance(),
    sourceTreeSha256: cap.sourceTreeSha256,
    stoppedProjection: {
      depth: cap.stoppedProjection.depth,
      frames: cap.stoppedProjection.frames,
      inlineDecorations: cap.stoppedProjection.inlineDecorations,
      maxLongTaskMs: cap.stoppedProjection.maxLongTaskMs,
      nodes: cap.stoppedProjection.nodes,
      samples: [...cap.stoppedProjection.samples],
      scopes: cap.stoppedProjection.scopes,
      variables: cap.stoppedProjection.variables,
    },
  };
  cap.artifactSha256 = computeD12ArtifactSha256(artifact);
  cap.rawInput = d12RawInput(artifact);
  return cap;
}

function d12CommonRevisionWork(measurement, revision) {
  const work = clone(measurement.metrics.b5IdleDebug);
  delete work.p95;
  delete work.samples;
  return revision === "baseline" ? { d12BaselineMeasuredWork: work } : { b5IdleDebugSession: work };
}

function d12CommonB4(prior, measurement) {
  return {
    budgetP50: prior?.b4ColdStartMs?.budgetP50 ?? 1500,
    budgetP95: prior?.b4ColdStartMs?.budgetP95 ?? 2500,
    samples: [...measurement.metrics.b4.samples],
  };
}

function d12CommonKeystroke(prior) {
  return clone(
    prior?.b5KeystrokeMs ?? {
      budgetMax: 50,
      captured: true,
      longTaskCount: 0,
      maxLongTaskMs: 0,
      samples: Array(10).fill(0),
    },
  );
}

function d12CommonB6(prior, measurement) {
  return {
    budgetP75: prior?.b6InteractionMs?.budgetP75 ?? 200,
    captured: prior?.b6InteractionMs?.captured ?? true,
    samples: [...measurement.metrics.b6.samples],
  };
}

function d12CommonWorkerCapture(prior) {
  return clone(
    prior?.workerLoadCapture ?? {
      editorWorkerLoaded: true,
      languageWorkerLoaded: false,
      totalWorkerRequests: 3,
      tsLanguageWorkerLoaded: false,
    },
  );
}

function d12CommonArtifact(measurement, revision) {
  const prior = measurement.rawInput?.artifact;
  return {
    schemaVersion: "1",
    kind: "common",
    revision,
    commit: measurement.commit,
    measuredAtIso: measurement.measuredAtIso,
    measurementHarnessSha256: measurement.measurementHarnessSha256,
    provenance: rawD12Provenance(measurement.provenance),
    sourceTreeSha256: measurement.sourceTreeSha256,
    b4ColdStartMs: d12CommonB4(prior, measurement),
    b5KeystrokeMs: d12CommonKeystroke(prior),
    ...d12CommonRevisionWork(measurement, revision),
    b6InteractionMs: d12CommonB6(prior, measurement),
    b11Memory: { supported: true, ...clone(measurement.metrics.b11) },
    workerLoadCapture: d12CommonWorkerCapture(prior),
  };
}

function d12Measurement(revision, sequence) {
  const values = D12_VALUES[revision];
  const candidate = revision === "candidate";
  const measurement = {
    artifactSha256: sequence.toString(16).repeat(64),
    commonCompletedAtIso: d12Timestamp(sequence, 2),
    complete: true,
    completedAtIso: d12Timestamp(sequence, candidate ? 4 : 2),
    commit: values.commit,
    scenario: values.scenario,
    measuredAtIso: d12Timestamp(sequence, 1),
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    perfRuns: 10,
    provenance: d12Provenance(),
    sequence,
    sourceTreeSha256: candidate ? SOURCE_TREE_SHA_256 : BASELINE_SOURCE_TREE_SHA_256,
    startedAtIso: d12Timestamp(sequence, 0),
    metrics: {
      bytes: {
        b1: 0,
        b2: values.b2,
        b3: values.b3,
        b10: values.b10,
      },
      b4: {
        samples: [...Array(9).fill(values.b4P50), values.b4P95],
        p50: values.b4P50,
        p95: values.b4P95,
      },
      b5IdleDebug: {
        ...(candidate
          ? {
              attempted: true,
              budgetMax: 50,
              captured: true,
              idleIntervalMs: 1100,
              processingSamples: Array(10).fill(values.b5P95),
              outputAcceptedBytes: values.outputAcceptedBytes,
              sessionStatus: values.sessionStatus,
            }
          : { captured: true, processingSamples: Array(10).fill(values.b5P95) }),
        expectedSampleCount: 10,
        matchedInputEventCounts: Array(10).fill(1),
        samples: Array(10).fill(values.b5P95),
        p95: values.b5P95,
        longTaskCount: 0,
        maxLongTaskMs: 0,
        totalMatchedInputEvents: 10,
        traceCaptured: values.traceCaptured,
      },
      b6: { samples: Array(10).fill(values.b6P75), p75: values.b6P75 },
      b11: {
        baselineBytes: values.b11Baseline,
        peakBytes: values.b11Peak,
        residualBytes: values.b11Residual,
        cycles: 2,
      },
      ...(candidate ? { capScenarios: d12CapScenarios(sequence) } : {}),
    },
  };
  const artifact = d12CommonArtifact(measurement, revision);
  measurement.artifactSha256 = computeD12ArtifactSha256(artifact);
  measurement.rawInput = d12RawInput(artifact);
  return measurement;
}

function refreshD12RawInput(measurement) {
  const revision = measurement.commit === BASELINE_COMMIT ? "baseline" : "candidate";
  const artifact = d12CommonArtifact(measurement, revision);
  measurement.artifactSha256 = computeD12ArtifactSha256(artifact);
  measurement.rawInput = d12RawInput(artifact);
  const cap = measurement.metrics.capScenarios;
  if (cap === undefined) return;
  const capArtifact = cap.rawInput.artifact;
  capArtifact.outputFlood = {
    adapterOutputBytes: cap.outputFlood.adapterOutputBytes,
    limitMarkers: cap.outputFlood.limitMarkers,
    maxLongTaskMs: cap.outputFlood.maxLongTaskMs,
    renderedRows: cap.outputFlood.renderedRows,
    renderedRowsCeiling: cap.outputFlood.renderedRowsCeiling,
    residualHeapBytes: cap.outputFlood.residualHeapBytes,
    retainedBytes: cap.outputFlood.retainedBytes,
    retainedEntries: cap.outputFlood.retainedEntries,
    stopSamples: [...cap.outputFlood.stopSamples],
  };
  capArtifact.stoppedProjection = {
    depth: cap.stoppedProjection.depth,
    frames: cap.stoppedProjection.frames,
    inlineDecorations: cap.stoppedProjection.inlineDecorations,
    maxLongTaskMs: cap.stoppedProjection.maxLongTaskMs,
    nodes: cap.stoppedProjection.nodes,
    samples: [...cap.stoppedProjection.samples],
    scopes: cap.stoppedProjection.scopes,
    variables: cap.stoppedProjection.variables,
  };
  cap.artifactSha256 = computeD12ArtifactSha256(capArtifact);
  rehashRawInput(cap.rawInput);
}

function refreshD12RawInputs(evidence) {
  for (const repetition of evidence.d12Comparison.repetitions) {
    refreshD12RawInput(repetition.baseline);
    refreshD12RawInput(repetition.candidate);
  }
}

function d12Aggregate(revision) {
  const values = D12_VALUES[revision];
  return {
    b1Bytes: 0,
    b2Bytes: values.b2,
    b3Bytes: values.b3,
    b10Bytes: values.b10,
    b4P50Ms: values.b4P50,
    b4P95Ms: values.b4P95,
    b5IdleDebugP95Ms: values.b5P95,
    b6P75Ms: values.b6P75,
    b11PeakBytes: values.b11Peak,
    b11ResidualBytes: values.b11Residual,
    b5IdleDebugLongTaskCount: 0,
    b5IdleDebugMaxLongTaskMs: 0,
  };
}

function d12BundleBinding(revision) {
  const values = D12_VALUES[revision];
  const input = {
    b1: { monacoMarkersInFirstLoad: 0, ok: true },
    b2: { shipsTotalBytes: values.b2, ok: true },
    b3: { largestWorkerBytes: values.b3, ok: true },
    b10: {
      ceilingBytes: 102_400,
      fileCount: 10,
      ok: true,
      totalGzipBytes: values.b10,
    },
    commit: values.commit,
    dependencyProvisioning: {
      args: ["ci", "--ignore-scripts"],
      command: "npm",
      lockfileSha256: "a".repeat(64),
    },
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
    sourceTreeSha256: revision === "baseline" ? BASELINE_SOURCE_TREE_SHA_256 : SOURCE_TREE_SHA_256,
  };
  return {
    ...input,
    bytes: { b1: 0, b2: values.b2, b3: values.b3, b10: values.b10 },
    measurementSha256: computeD12BundleMeasurementSha256(input),
  };
}

function d12Comparison() {
  const baseline = d12Aggregate("baseline");
  const candidate = d12Aggregate("candidate");
  return {
    schemaVersion: "1",
    baselineCommit: BASELINE_COMMIT,
    baselineSourceTreeSha256: BASELINE_SOURCE_TREE_SHA_256,
    bundles: {
      baseline: d12BundleBinding("baseline"),
      candidate: d12BundleBinding("candidate"),
    },
    candidateCommit: CANDIDATE_COMMIT,
    candidateSourceTreeSha256: SOURCE_TREE_SHA_256,
    measurementHarnessSha256: MEASUREMENT_HARNESS_SHA_256,
    dependencyProvisioning: {
      command: "npm",
      args: ["ci", "--ignore-scripts"],
      lockfileSha256: "a".repeat(64),
    },
    aggregateRule: "median-run-level-percentile",
    warmUp: { runs: 1, procedure: "discard one complete suite run" },
    repetitions: [
      {
        order: ["baseline", "candidate"],
        baseline: d12Measurement("baseline", 1),
        candidate: d12Measurement("candidate", 2),
      },
      {
        order: ["candidate", "baseline"],
        baseline: d12Measurement("baseline", 4),
        candidate: d12Measurement("candidate", 3),
      },
      {
        order: ["baseline", "candidate"],
        baseline: d12Measurement("baseline", 5),
        candidate: d12Measurement("candidate", 6),
      },
    ],
    aggregates: { baseline, candidate },
    deltas: Object.fromEntries(
      Object.keys(baseline).map((field) => [field, candidate[field] - baseline[field]]),
    ),
  };
}

function editorEvidence(overrides = {}) {
  const comparison = d12Comparison();
  const candidate = comparison.repetitions[0].candidate;
  return {
    measuredAtIso: d12Timestamp(6, 1),
    commit: CANDIDATE_COMMIT,
    freshnessBinding: "source-tree-v1",
    sourceTreeSha256: SOURCE_TREE_SHA_256,
    b4ColdStartMs: { budgetP50: 1500, budgetP95: 2500, p50: 1050, p95: 1250 },
    b5KeystrokeMs: { budgetMax: 50, captured: true, longTaskCount: 0, maxLongTaskMs: 0 },
    b5IdleDebugSession: clone(candidate.metrics.b5IdleDebug),
    b6InteractionMs: { budgetP75: 200, captured: true, p75: 109 },
    b11Memory: {
      supported: true,
      baselineBytes: 12_000_000,
      peakBytes: 23_000_000,
      residualBytes: 13_000_000,
      cycles: 2,
    },
    workerLoadCapture: {
      totalWorkerRequests: 3,
      editorWorkerLoaded: true,
      languageWorkerLoaded: false,
      tsLanguageWorkerLoaded: false,
    },
    d12Comparison: comparison,
    ...overrides,
  };
}

describe("evaluateWorkspaceEvidence", () => {
  it("passes clean, within-budget evidence", () => {
    expect(evaluateWorkspaceEvidence(workspaceEvidence())).toEqual({ passed: true, failures: [] });
  });

  it("fails a frame-gap p75 budget breach", () => {
    const result = evaluateWorkspaceEvidence(workspaceEvidence({ frameGapP75Ms: 60 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/p75 60ms > budget 34ms/u);
  });

  it("fails a long-task budget breach", () => {
    const result = evaluateWorkspaceEvidence(workspaceEvidence({ maxLongTaskMs: 250 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/long task 250ms > 100ms/u);
  });

  it("fails write/PUT coalescing regressions", () => {
    const result = evaluateWorkspaceEvidence(
      workspaceEvidence({ viewWrites: 3, workspacePuts: 4 }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/viewWrites 3 > 1/u);
    expect(result.failures.join("\n")).toMatch(/workspacePuts 4 > 1/u);
  });

  it("rejects vacuous evidence with too few frame samples", () => {
    const result = evaluateWorkspaceEvidence(workspaceEvidence({ frameGapSamples: 2 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/too few frame samples/u);
  });

  it("fails when there are no runs", () => {
    expect(evaluateWorkspaceEvidence({ runs: {} }).passed).toBe(false);
  });
});

describe("evaluateEditorEvidence", () => {
  it("rejects unknown final-document fields at the redaction boundary", () => {
    const evidence = editorEvidence();
    evidence.unredactedBody = "forbidden";

    expect(evaluateEditorEvidence(evidence).failures.join("\n")).toMatch(
      /d12 final editor evidence: non-canonical or unknown field/u,
    );
  });

  it("requires the squash-stable source-tree freshness binding on every D12 document", () => {
    const evidence = editorEvidence();
    delete evidence.freshnessBinding;

    expect(evaluateEditorEvidence(evidence).failures.join("\n")).toMatch(
      /freshnessBinding must be source-tree-v1/u,
    );
  });

  it("accepts only canonical final D12 JSON bytes and rejects duplicate-key documents", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-final-d12-evidence-"));
    const path = join(root, "evidence.json");
    const evidence = editorEvidence();
    try {
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      expect(readEvidence(path)).toEqual({ evidence });

      writeFileSync(path, JSON.stringify(evidence), "utf8");
      expect(readEvidence(path).error).toMatch(/non-canonical D12 evidence file/u);

      const canonical = JSON.stringify(evidence, null, 2);
      writeFileSync(
        path,
        `${canonical.slice(0, -1)},\n  "commit": "ffffffffffffffffffffffffffffffffffffffff"\n}\n`,
      );
      expect(readEvidence(path).error).toMatch(/non-canonical D12 evidence file/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the D12 baseline comparison is missing", () => {
    const result = evaluateEditorEvidence(editorEvidence({ d12Comparison: undefined }));

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("editor evidence missing d12Comparison");
  });

  it("passes clean editor evidence", () => {
    expect(evaluateEditorEvidence(editorEvidence())).toEqual({ passed: true, failures: [] });
  });

  it("fails a cold-start budget breach", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({ b4ColdStartMs: { budgetP50: 1500, budgetP95: 2500, p50: 1800, p95: 3000 } }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/cold-start p50 1800ms > budget 1500ms/u);
  });

  it("fails when a Monaco language worker loaded (editor-only budget breach)", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({
        workerLoadCapture: {
          totalWorkerRequests: 4,
          editorWorkerLoaded: true,
          languageWorkerLoaded: true,
          tsLanguageWorkerLoaded: true,
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/language worker was loaded/u);
  });

  it("fails when b11 memory is not measured", () => {
    const result = evaluateEditorEvidence(editorEvidence({ b11Memory: { supported: false } }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/b11 memory/u);
  });

  it("fails B11 peak and residual growth ceilings", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({
        b11Memory: {
          supported: true,
          baselineBytes: 1,
          peakBytes: 128 * 1024 * 1024 + 2,
          residualBytes: 16 * 1024 * 1024 + 2,
          cycles: 2,
        },
      }),
    );

    expect(result.failures).toContain("b11 peak growth 134217729 bytes > budget 134217728 bytes");
    expect(result.failures).toContain("b11 residual growth 16777217 bytes > budget 16777216 bytes");
  });

  it("fails when idle-debug evidence is missing", () => {
    const result = evaluateEditorEvidence(editorEvidence({ b5IdleDebugSession: undefined }));

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/missing b5IdleDebugSession/u);
  });

  it("rejects all-zero idle-debug samples and input-event counts", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({
        b5IdleDebugSession: idleDebugEvidence({
          matchedInputEventCounts: [0, 0, 0],
          p95: 0,
          processingSamples: [0, 0, 0],
          totalMatchedInputEvents: 0,
        }),
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/non-positive measurement/u);
    expect(result.failures.join("\n")).toMatch(/zero or invalid match count/u);
  });

  it("rejects a missing input dispatch in any idle-debug sample", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({
        b5IdleDebugSession: idleDebugEvidence({
          matchedInputEventCounts: [2, 0, 3],
          totalMatchedInputEvents: 5,
        }),
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/zero or invalid match count/u);
  });

  it("rejects inconsistent matched input-event totals", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({
        b5IdleDebugSession: idleDebugEvidence({ totalMatchedInputEvents: 99 }),
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/totalMatchedInputEvents 99 != 6/u);
  });

  it("enforces idle-debug sample, long-task, output, and session guards", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({
        b5IdleDebugSession: idleDebugEvidence({
          longTaskCount: 1,
          maxLongTaskMs: 55,
          outputAcceptedBytes: 12,
          p95: 55,
          processingSamples: [4, 55, 5],
          sessionStatus: "stopped",
        }),
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/p95 55ms >= budget 50ms/u);
    expect(result.failures.join("\n")).toMatch(/processing sample reached budget/u);
    expect(result.failures.join("\n")).toMatch(/one or more long tasks/u);
    expect(result.failures.join("\n")).toMatch(/accepted visible output/u);
    expect(result.failures.join("\n")).toMatch(/neither paused nor running/u);
  });
});

describe("evaluateD12Comparison", () => {
  it("accepts a complete paired comparison at the regression boundaries", () => {
    const evidence = editorEvidence();
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.candidate.metrics.b4.samples = [...Array(9).fill(1100), 1300];
      repetition.candidate.metrics.b4.p50 = 1100;
      repetition.candidate.metrics.b4.p95 = 1300;
      repetition.candidate.metrics.b6.samples = Array(10).fill(110);
      repetition.candidate.metrics.b6.p75 = 110;
    }
    Object.assign(evidence.d12Comparison.aggregates.candidate, {
      b4P50Ms: 1100,
      b4P95Ms: 1300,
      b6P75Ms: 110,
    });
    Object.assign(evidence.d12Comparison.deltas, {
      b4P50Ms: 100,
      b4P95Ms: 100,
      b6P75Ms: 10,
    });
    Object.assign(evidence.b4ColdStartMs, { p50: 1100, p95: 1300 });
    evidence.b6InteractionMs.p75 = 110;
    refreshD12RawInputs(evidence);

    expect(evaluateD12Comparison(evidence)).toEqual([]);
  });

  it("requires the exact D12 baseline commit", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.baselineCommit = "a".repeat(40);

    expect(evaluateD12Comparison(evidence)).toContain(
      `d12 baseline commit must be exactly ${BASELINE_COMMIT}`,
    );
  });

  it("requires the closed median aggregate rule", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.aggregateRule = "average";

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 aggregateRule must be median-run-level-percentile",
    );
  });

  it("requires the full candidate commit to match the reachable top-level stamp", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.candidateCommit = "6c3d061e";

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 candidate commit must be the full top-level evidence commit",
    );
  });

  it("requires at least three paired repetitions", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions.length = 2;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 comparison requires at least 3 complete paired repetitions",
    );
  });

  it("rejects incomplete and under-sampled revision measurements", () => {
    const evidence = editorEvidence();
    const candidate = evidence.d12Comparison.repetitions[0].candidate;
    candidate.complete = false;
    candidate.perfRuns = 9;

    const failures = evaluateD12Comparison(evidence);
    expect(failures).toContain("d12 repetition 1 candidate: measurement is not complete");
    expect(failures).toContain("d12 repetition 1 candidate: KEIKO_PERF_RUNS must be at least 10");
  });

  it("requires a real idle-debug candidate scenario in every repetition", () => {
    const evidence = editorEvidence();
    const candidate = evidence.d12Comparison.repetitions[0].candidate;
    candidate.scenario = "baseline-editor";
    candidate.metrics.b5IdleDebug.traceCaptured = false;
    candidate.metrics.b5IdleDebug.sessionStatus = "none";

    const failures = evaluateD12Comparison(evidence);
    expect(failures).toContain("d12 repetition 1 candidate: scenario must be idle-debug-session");
    expect(failures).toContain("d12 repetition 1 candidate: idle-debug trace was not captured");
    expect(failures).toContain(
      "d12 repetition 1 candidate: idle-debug session was neither paused nor running",
    );
  });

  it.each(["baseline", "candidate"])(
    "requires B5 trace capture and an expected sample count for every %s measurement",
    (revision) => {
      const evidence = editorEvidence();
      const metric = evidence.d12Comparison.repetitions[0][revision].metrics.b5IdleDebug;
      metric.traceCaptured = false;
      delete metric.expectedSampleCount;

      const failures = evaluateD12Comparison(evidence);
      expect(failures).toContain(
        `d12 repetition 1 ${revision} B5 idle-debug: traceCaptured must be true`,
      );
      expect(failures).toContain(
        `d12 repetition 1 ${revision} B5 idle-debug: expectedSampleCount is not a positive integer`,
      );
    },
  );

  it("requires positive B5 input-event counts with the same length as samples", () => {
    const evidence = editorEvidence();
    const metric = evidence.d12Comparison.repetitions[0].baseline.metrics.b5IdleDebug;
    metric.expectedSampleCount = 9;
    metric.matchedInputEventCounts = [1, 0];
    metric.totalMatchedInputEvents = 1;

    const failures = evaluateD12Comparison(evidence);
    expect(failures).toContain(
      "d12 repetition 1 baseline B5 idle-debug: expectedSampleCount 9 != samples length 10",
    );
    expect(failures).toContain(
      "d12 repetition 1 baseline B5 idle-debug: matchedInputEventCounts length 2 != samples length 10",
    );
    expect(failures).toContain(
      "d12 repetition 1 baseline B5 idle-debug: matchedInputEventCounts contain a non-positive or invalid count",
    );
  });

  it("requires the exact total number of matched B5 input events", () => {
    const evidence = editorEvidence();
    const metric = evidence.d12Comparison.repetitions[0].candidate.metrics.b5IdleDebug;
    metric.totalMatchedInputEvents = 11;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 repetition 1 candidate B5 idle-debug: totalMatchedInputEvents 11 != measured 10",
    );
  });

  it("rejects missing raw samples and a stale run-level percentile", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions[0].candidate.metrics.b6.samples = [];
    evidence.d12Comparison.repetitions[1].candidate.metrics.b4.p95 = 999;

    const failures = evaluateD12Comparison(evidence).join("\n");
    expect(failures).toMatch(/B6: raw samples are missing or fewer than KEIKO_PERF_RUNS/u);
    expect(failures).toMatch(/B4: p95 999ms != measured 1250ms/u);
  });

  it("rejects a negative raw B5 keystroke long-task sample", () => {
    const evidence = editorEvidence();
    const baseline = evidence.d12Comparison.repetitions[0].baseline;
    baseline.rawInput.artifact.b5KeystrokeMs.samples[0] = -1;
    refreshD12RawInput(baseline);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      /B5 keystroke: raw samples contain a negative or invalid measurement/u,
    );
  });

  it("accepts fractional cap percentiles under the shared nearest-rank convention", () => {
    const evidence = editorEvidence();
    const cap = evidence.d12Comparison.repetitions[0].candidate.metrics.capScenarios;
    cap.stoppedProjection.samples = [
      101.1, 102.2, 103.3, 104.4, 105.5, 106.6, 107.7, 108.8, 109.9, 110.1,
    ];
    cap.stoppedProjection.p75 = 108.8;
    cap.outputFlood.stopSamples = [
      111.1, 112.2, 113.3, 114.4, 115.5, 116.6, 117.7, 118.8, 119.9, 120.1,
    ];
    cap.outputFlood.stopP75 = 118.8;
    refreshD12RawInput(evidence.d12Comparison.repetitions[0].candidate);

    expect(evaluateD12Comparison(evidence)).toEqual([]);
  });

  it("rejects normalized common and cap tampering against committed redacted raw inputs", () => {
    const evidence = editorEvidence();
    const common = evidence.d12Comparison.repetitions[0].baseline;
    const cap = evidence.d12Comparison.repetitions[0].candidate.metrics.capScenarios;
    common.metrics.b11.residualBytes += 1;
    cap.rawInput.artifact.outputFlood.retainedBytes -= 1;
    rehashRawInput(cap.rawInput);

    const failures = evaluateD12Comparison(evidence).join("\n");
    expect(failures).toMatch(
      /normalized common measurement does not match committed raw derivation/u,
    );
    expect(failures).toMatch(/normalized cap measurement does not match committed raw derivation/u);
  });

  it("rejects a canonical raw-input value whose recomputed digest is stale", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions[1].candidate.rawInput.artifact.b6InteractionMs.samples[0] += 1;

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      /raw input sha256 does not match its canonical artifact/u,
    );
  });

  it.each([
    [
      "envelope",
      (evidence) => {
        evidence.d12Comparison.repetitions[0].baseline.rawInput.unredactedBody = "forbidden";
      },
    ],
    [
      "nested metric",
      (evidence) => {
        const measurement = evidence.d12Comparison.repetitions[0].baseline;
        measurement.metrics.b4.unredactedBody = "forbidden";
        measurement.rawInput.artifact.b4ColdStartMs.unredactedBody = "forbidden";
        rehashRawInput(measurement.rawInput);
      },
    ],
    [
      "nested cap",
      (evidence) => {
        const cap = evidence.d12Comparison.repetitions[0].candidate.metrics.capScenarios;
        cap.outputFlood.unredactedBody = "forbidden";
        cap.rawInput.artifact.outputFlood.unredactedBody = "forbidden";
        rehashRawInput(cap.rawInput);
      },
    ],
    [
      "nested provenance",
      (evidence) => {
        for (const repetition of evidence.d12Comparison.repetitions) {
          for (const revision of ["baseline", "candidate"]) {
            const measurement = repetition[revision];
            measurement.provenance.unredactedBody = "forbidden";
            measurement.rawInput.artifact.provenance.unredactedBody = "forbidden";
            rehashRawInput(measurement.rawInput);
            if (revision === "candidate") {
              const cap = measurement.metrics.capScenarios;
              cap.rawInput.artifact.provenance.unredactedBody = "forbidden";
              rehashRawInput(cap.rawInput);
            }
          }
        }
      },
    ],
  ])(
    "rejects a recursively open raw-input %s even after coherent mirror/hash refresh",
    (_name, mutate) => {
      const evidence = editorEvidence();
      mutate(evidence);

      expect(evaluateD12Comparison(evidence).join("\n")).toMatch(/non-canonical|unknown field/u);
    },
  );

  it.each([
    ["comparison", (evidence) => (evidence.d12Comparison.unredactedBody = "forbidden")],
    [
      "repetition",
      (evidence) => (evidence.d12Comparison.repetitions[0].unredactedBody = "forbidden"),
    ],
    [
      "measurement",
      (evidence) => (evidence.d12Comparison.repetitions[0].baseline.unredactedBody = "forbidden"),
    ],
    [
      "metrics",
      (evidence) =>
        (evidence.d12Comparison.repetitions[0].baseline.metrics.unredactedBody = "forbidden"),
    ],
    [
      "cap container",
      (evidence) =>
        (evidence.d12Comparison.repetitions[0].candidate.metrics.capScenarios.unredactedBody =
          "forbidden"),
    ],
    ["aggregates", (evidence) => (evidence.d12Comparison.aggregates.unredactedBody = "forbidden")],
    [
      "aggregate record",
      (evidence) => (evidence.d12Comparison.aggregates.baseline.unredactedBody = "forbidden"),
    ],
    ["delta record", (evidence) => (evidence.d12Comparison.deltas.unredactedBody = "forbidden")],
    [
      "bundle bytes",
      (evidence) => (evidence.d12Comparison.bundles.baseline.bytes.unredactedBody = "forbidden"),
    ],
    [
      "bundle runtime",
      (evidence) => (evidence.d12Comparison.bundles.baseline.runtime.unredactedBody = "forbidden"),
    ],
  ])("rejects a recursively open normalized D12 %s", (_name, mutate) => {
    const evidence = editorEvidence();
    mutate(evidence);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(/non-canonical|unknown field/u);
  });

  it("recomputes each committed bundle measurement fingerprint", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.bundles.baseline.b2.shipsTotalBytes += 1;

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      /measurementSha256 does not match committed bundle measurements/u,
    );
  });

  it("rejects a coherently re-fingerprinted foreign bundle producer", () => {
    const evidence = editorEvidence();
    const bundle = evidence.d12Comparison.bundles.baseline;
    bundle.producerCommit = "f".repeat(40);
    bundle.measurementSha256 = computeD12BundleMeasurementSha256(bundle);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      /producer commit does not match comparison candidate/u,
    );
  });

  it("rejects a coherently re-fingerprinted bundle runtime that differs from browser provenance", () => {
    const evidence = editorEvidence();
    const bundle = evidence.d12Comparison.bundles.candidate;
    bundle.runtime.zlibVersion = "1.3.2";
    bundle.measurementSha256 = computeD12BundleMeasurementSha256(bundle);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      /runtime does not match common browser provenance/u,
    );
  });

  it.each([
    [
      "divergent processingSamples",
      (measurement) => {
        measurement.metrics.b5IdleDebug.processingSamples = Array(10).fill(1);
      },
    ],
    [
      "captured false",
      (measurement) => {
        measurement.metrics.b5IdleDebug.captured = false;
      },
    ],
    [
      "candidate attempted false",
      (_measurement, evidence) => {
        evidence.d12Comparison.repetitions[1].candidate.metrics.b5IdleDebug.attempted = false;
        refreshD12RawInput(evidence.d12Comparison.repetitions[1].candidate);
      },
    ],
    [
      "candidate budget and idle interval",
      (_measurement, evidence) => {
        const candidate = evidence.d12Comparison.repetitions[1].candidate;
        candidate.metrics.b5IdleDebug.budgetMax = 0;
        candidate.metrics.b5IdleDebug.idleIntervalMs = 0;
        refreshD12RawInput(candidate);
      },
    ],
    [
      "B11 peak below baseline",
      (measurement) => {
        measurement.metrics.b11.peakBytes = measurement.metrics.b11.baselineBytes - 1;
      },
    ],
  ])("re-derives and rejects the committed raw invariant %s", (_name, mutate) => {
    const evidence = editorEvidence();
    const baseline = evidence.d12Comparison.repetitions[0].baseline;
    mutate(baseline, evidence);
    refreshD12RawInput(baseline);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      /committed raw|processingSamples|captured|attempted|budgetMax|idleIntervalMs|peakBytes/u,
    );
  });

  it("rejects a fabricated unique artifact digest even when every committed mirror is refreshed", () => {
    const evidence = editorEvidence();
    const measurement = evidence.d12Comparison.repetitions[0].baseline;
    measurement.artifactSha256 = "f".repeat(64);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      /artifactSha256 does not match canonical committed raw artifact/u,
    );
  });

  it("rejects a coherently drifted baseline source digest against the pinned Git commit", () => {
    const evidence = editorEvidence();
    const drifted = "f".repeat(64);
    evidence.d12Comparison.baselineSourceTreeSha256 = drifted;
    evidence.d12Comparison.bundles.baseline.sourceTreeSha256 = drifted;
    evidence.d12Comparison.bundles.baseline.measurementSha256 = computeD12BundleMeasurementSha256(
      evidence.d12Comparison.bundles.baseline,
    );
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.baseline.sourceTreeSha256 = drifted;
      refreshD12RawInput(repetition.baseline);
    }

    expect(evaluateD12Comparison(evidence)).toEqual([]);
    expect(
      evaluateFreshness(evidence, {
        computeBaselineSourceTreeSha256: () => BASELINE_SOURCE_TREE_SHA_256,
        computeLockfileSha256: () => "a".repeat(64),
        computeMeasurementHarnessSha256: () => MEASUREMENT_HARNESS_SHA_256,
        computeSourceTreeSha256: () => SOURCE_TREE_SHA_256,
        isAncestor: () => true,
      }).failures.join("\n"),
    ).toMatch(/pinned baseline performance subject/u);
  });

  it("requires baseline and candidate execution order to alternate", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions[1].order = ["baseline", "candidate"];

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 repetition 2: execution order did not alternate",
    );
  });

  it("requires identical Linux, toolchain, hardware, and warm-up provenance", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions[1].candidate.provenance.hardware.cpuModel = "other CPU";

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 repetition 2 candidate: provenance does not match baseline",
    );
  });

  it("rejects non-Linux and unpinned Node/npm provenance", () => {
    const evidence = editorEvidence();
    const provenance = evidence.d12Comparison.repetitions[0].baseline.provenance;
    provenance.platform = "darwin";
    provenance.nodeVersion = "24.17.0";
    provenance.npmVersion = "11.15.0";

    const failures = evaluateD12Comparison(evidence);
    expect(failures).toContain("d12 repetition 1 baseline: platform must be linux");
    expect(failures).toContain("d12 repetition 1 baseline: Node.js version must be 24.18.0");
    expect(failures).toContain("d12 repetition 1 baseline: npm version must be 11.16.0");
  });

  it("rejects an aggregate that is not the median run-level percentile", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.aggregates.candidate.b4P95Ms = 1249;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 candidate aggregate b4P95Ms 1249 != measured 1250",
    );
  });

  it("uses the median of the repetition-level percentiles", () => {
    const evidence = editorEvidence();
    const values = [108, 110, 109];
    for (const [index, repetition] of evidence.d12Comparison.repetitions.entries()) {
      repetition.candidate.metrics.b6 = {
        samples: Array(10).fill(values[index]),
        p75: values[index],
      };
    }
    refreshD12RawInputs(evidence);

    expect(evaluateD12Comparison(evidence)).toEqual([]);
  });

  it.each(["b1Bytes", "b2Bytes", "b3Bytes", "b10Bytes"])("requires the exact %s delta", (field) => {
    const evidence = editorEvidence();
    evidence.d12Comparison.deltas[field] += 1;

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(
      new RegExp(`d12 deltas ${field} .* != measured`, "u"),
    );
  });

  it("fails B4 regression beyond max(100 ms, 10%)", () => {
    const evidence = editorEvidence();
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.candidate.metrics.b4.samples = [...Array(9).fill(1101), 1250];
      repetition.candidate.metrics.b4.p50 = 1101;
    }
    evidence.d12Comparison.aggregates.candidate.b4P50Ms = 1101;
    evidence.d12Comparison.deltas.b4P50Ms = 101;
    evidence.b4ColdStartMs.p50 = 1101;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 B4 p50 regression 101ms > allowed 100ms",
    );
  });

  it("fails B6 regression beyond max(10 ms, 10%)", () => {
    const evidence = editorEvidence();
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.candidate.metrics.b6 = { samples: Array(10).fill(111), p75: 111 };
    }
    evidence.d12Comparison.aggregates.candidate.b6P75Ms = 111;
    evidence.d12Comparison.deltas.b6P75Ms = 11;
    evidence.b6InteractionMs.p75 = 111;

    expect(evaluateD12Comparison(evidence)).toContain("d12 B6 p75 regression 11ms > allowed 10ms");
  });

  it("fails the absolute B6 p75 ceiling even when the relative delta passes", () => {
    const evidence = editorEvidence();
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.baseline.metrics.b6 = { samples: Array(10).fill(200), p75: 200 };
      repetition.candidate.metrics.b6 = { samples: Array(10).fill(201), p75: 201 };
    }
    evidence.d12Comparison.aggregates.baseline.b6P75Ms = 200;
    evidence.d12Comparison.aggregates.candidate.b6P75Ms = 201;
    evidence.d12Comparison.deltas.b6P75Ms = 1;
    evidence.b6InteractionMs.p75 = 201;

    expect(evaluateD12Comparison(evidence)).toContain("d12 B6 p75 201ms > budget 200ms");
  });

  it("fails a B5 idle-debug long task even when the aggregate latency passes", () => {
    const evidence = editorEvidence();
    const metric = evidence.d12Comparison.repetitions[0].candidate.metrics.b5IdleDebug;
    metric.longTaskCount = 1;
    metric.maxLongTaskMs = 51;
    evidence.d12Comparison.aggregates.candidate.b5IdleDebugLongTaskCount = 1;
    evidence.d12Comparison.aggregates.candidate.b5IdleDebugMaxLongTaskMs = 51;
    evidence.d12Comparison.deltas.b5IdleDebugLongTaskCount = 1;
    evidence.d12Comparison.deltas.b5IdleDebugMaxLongTaskMs = 51;
    evidence.b5IdleDebugSession.longTaskCount = 1;
    evidence.b5IdleDebugSession.maxLongTaskMs = 51;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 B5 idle-debug candidate added one or more long tasks",
    );
  });

  it("fails the B5 measured-work ceiling and still validates its exact delta", () => {
    const evidence = editorEvidence();
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.candidate.metrics.b5IdleDebug.samples = Array(10).fill(50);
      repetition.candidate.metrics.b5IdleDebug.p95 = 50;
    }
    evidence.d12Comparison.aggregates.candidate.b5IdleDebugP95Ms = 50;
    evidence.d12Comparison.deltas.b5IdleDebugP95Ms = 40;
    evidence.b5IdleDebugSession.p95 = 50;

    expect(evaluateD12Comparison(evidence)).toContain("d12 B5 idle-debug p95 50ms >= budget 50ms");
  });

  it("requires exact B11 peak and post-stop residual deltas", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.deltas.b11PeakBytes = 0;
    evidence.d12Comparison.deltas.b11ResidualBytes = 0;

    const failures = evaluateD12Comparison(evidence).join("\n");
    expect(failures).toMatch(/d12 deltas b11PeakBytes 0 != measured 3000000/u);
    expect(failures).toMatch(/d12 deltas b11ResidualBytes 0 != measured 2000000/u);
  });

  it("fails a B1 byte ceiling breach after validating its exact delta", () => {
    const evidence = editorEvidence();
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.candidate.metrics.bytes.b1 = 1;
    }
    evidence.d12Comparison.aggregates.candidate.b1Bytes = 1;
    evidence.d12Comparison.deltas.b1Bytes = 1;

    expect(evaluateD12Comparison(evidence)).toContain("d12 B1 1 bytes > budget 0 bytes");
  });

  it.each([
    ["b2", 2_621_441, 1_000_000, 2_621_440],
    ["b3", 768_001, 200_000, 768_000],
    ["b10", 102_401, 80_000, 102_400],
  ])("fails the absolute %s byte ceiling", (metric, candidate, baseline, budget) => {
    const evidence = editorEvidence();
    for (const repetition of evidence.d12Comparison.repetitions) {
      repetition.candidate.metrics.bytes[metric] = candidate;
    }
    evidence.d12Comparison.aggregates.candidate[`${metric}Bytes`] = candidate;
    evidence.d12Comparison.deltas[`${metric}Bytes`] = candidate - baseline;

    expect(evaluateD12Comparison(evidence)).toContain(
      `d12 ${metric.toUpperCase()} ${candidate} bytes > budget ${budget} bytes`,
    );
  });

  it("rejects candidate aggregate values that do not match top-level candidate evidence", () => {
    const evidence = editorEvidence();
    evidence.b4ColdStartMs.p95 = 1249;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 candidate aggregate alignment b4P95Ms 1250 != measured 1249",
    );
  });

  it.each([0, 1, 2])("requires candidate cap evidence in repetition %i", (index) => {
    const evidence = editorEvidence();
    delete evidence.d12Comparison.repetitions[index].candidate.metrics.capScenarios;

    expect(evaluateD12Comparison(evidence)).toContain(
      `d12 repetition ${index + 1} candidate: capScenarios is missing`,
    );
  });

  it.each([
    [
      "missing",
      (comparison) => delete comparison.dependencyProvisioning,
      /dependency provisioning is missing/u,
    ],
    [
      "unknown command",
      (comparison) => (comparison.dependencyProvisioning.command = "pnpm"),
      /command must be npm/u,
    ],
    [
      "weakened arguments",
      (comparison) => (comparison.dependencyProvisioning.args = ["install"]),
      /arguments must equal npm ci --ignore-scripts/u,
    ],
    [
      "malformed lock digest",
      (comparison) => (comparison.dependencyProvisioning.lockfileSha256 = "invalid"),
      /lockfileSha256 is not a lowercase SHA-256 digest/u,
    ],
  ])("rejects %s D12 dependency provisioning", (_name, mutate, expected) => {
    const evidence = editorEvidence();
    mutate(evidence.d12Comparison);
    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(expected);
  });

  it("binds every measured repetition to the provisioned lockfile digest", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions[1].candidate.provenance.lockfileSha256 = "b".repeat(64);

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 repetition 2 candidate: lockfileSha256 does not match dependency provisioning",
    );
  });

  it.each([
    ["depth", (cap) => (cap.stoppedProjection.depth = 3), /stoppedProjection depth must equal 4/u],
    ["frames", (cap) => (cap.stoppedProjection.frames = 127), /frames must equal 128/u],
    [
      "decorations",
      (cap) => (cap.stoppedProjection.inlineDecorations = 199),
      /inlineDecorations must equal 200/u,
    ],
    ["nodes", (cap) => (cap.stoppedProjection.nodes = 999), /nodes must equal 1000/u],
    ["scopes", (cap) => (cap.stoppedProjection.scopes = 31), /scopes must equal 32/u],
    ["variables", (cap) => (cap.stoppedProjection.variables = 199), /variables must equal 200/u],
    ["stopped samples", (cap) => (cap.stoppedProjection.samples = []), /raw samples are missing/u],
    [
      "stopped p75",
      (cap) => {
        cap.stoppedProjection.samples = Array(10).fill(201);
        cap.stoppedProjection.p75 = 201;
      },
      /stoppedProjection: p75 201ms > budget 200ms/u,
    ],
    [
      "stopped long task",
      (cap) => (cap.stoppedProjection.maxLongTaskMs = 51),
      /maxLongTaskMs 51ms > budget 50ms/u,
    ],
    [
      "adapter output",
      (cap) => (cap.outputFlood.adapterOutputBytes = 1_048_575),
      /adapterOutputBytes must be at least 1048576/u,
    ],
    ["limit marker", (cap) => (cap.outputFlood.limitMarkers = 2), /limitMarkers must equal 1/u],
    [
      "render ceiling",
      (cap) => (cap.outputFlood.renderedRowsCeiling = 201),
      /renderedRowsCeiling must equal 200/u,
    ],
    [
      "render rows",
      (cap) => (cap.outputFlood.renderedRows = 201),
      /renderedRows exceeds budget 200/u,
    ],
    [
      "retained bytes",
      (cap) => (cap.outputFlood.retainedBytes = 524_289),
      /retainedBytes exceeds budget 524288/u,
    ],
    [
      "retained entries",
      (cap) => (cap.outputFlood.retainedEntries = 2_001),
      /retainedEntries exceeds budget 2000/u,
    ],
    ["stop samples", (cap) => (cap.outputFlood.stopSamples = []), /raw samples are missing/u],
    [
      "stop p75",
      (cap) => {
        cap.outputFlood.stopSamples = Array(10).fill(201);
        cap.outputFlood.stopP75 = 201;
      },
      /outputFlood stop: p75 201ms > budget 200ms/u,
    ],
    [
      "output long task",
      (cap) => (cap.outputFlood.maxLongTaskMs = 51),
      /outputFlood maxLongTaskMs 51ms > budget 50ms/u,
    ],
    [
      "residual heap",
      (cap) => (cap.outputFlood.residualHeapBytes = 16_777_217),
      /residualHeapBytes exceeds budget 16777216/u,
    ],
  ])("rejects invalid candidate cap %s", (_name, mutate, expected) => {
    const evidence = editorEvidence();
    mutate(evidence.d12Comparison.repetitions[0].candidate.metrics.capScenarios);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(expected);
  });

  it.each([
    [
      "artifactSha256",
      (evidence) => delete evidence.d12Comparison.repetitions[0].baseline.artifactSha256,
      /baseline: artifactSha256 is not a lowercase SHA-256 digest/u,
    ],
    [
      "sourceTreeSha256",
      (evidence) => delete evidence.d12Comparison.repetitions[0].baseline.sourceTreeSha256,
      /baseline: sourceTreeSha256 is not a lowercase SHA-256 digest/u,
    ],
    [
      "measurementHarnessSha256",
      (evidence) => delete evidence.d12Comparison.repetitions[0].baseline.measurementHarnessSha256,
      /baseline: measurementHarnessSha256 is not a lowercase SHA-256 digest/u,
    ],
    [
      "sequence",
      (evidence) => delete evidence.d12Comparison.repetitions[0].baseline.sequence,
      /baseline: sequence is not a positive integer/u,
    ],
    [
      "startedAtIso",
      (evidence) => delete evidence.d12Comparison.repetitions[0].baseline.startedAtIso,
      /baseline: startedAtIso is not parseable/u,
    ],
    [
      "commonCompletedAtIso",
      (evidence) => delete evidence.d12Comparison.repetitions[0].baseline.commonCompletedAtIso,
      /baseline: commonCompletedAtIso is not parseable/u,
    ],
    [
      "completedAtIso",
      (evidence) => delete evidence.d12Comparison.repetitions[0].baseline.completedAtIso,
      /baseline: completedAtIso is not parseable/u,
    ],
  ])("requires repetition binding field %s", (_field, mutate, expected) => {
    const evidence = editorEvidence();
    mutate(evidence);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(expected);
  });

  it("requires unique artifact digests for every common and cap run", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions[1].candidate.artifactSha256 =
      evidence.d12Comparison.repetitions[0].baseline.artifactSha256;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 artifactSha256 bindings must be unique across all common and cap repetitions",
    );
  });

  it("requires sequence numbers to encode the recorded execution order", () => {
    const evidence = editorEvidence();
    evidence.d12Comparison.repetitions[0].candidate.sequence = 5;
    evidence.d12Comparison.repetitions[0].candidate.metrics.capScenarios.sequence = 5;

    expect(evaluateD12Comparison(evidence)).toContain("d12 candidate sequence 5 != actual order 2");
  });

  it("rejects overlapping execution intervals", () => {
    const evidence = editorEvidence();
    const candidate = evidence.d12Comparison.repetitions[0].candidate;
    candidate.startedAtIso = evidence.d12Comparison.repetitions[0].baseline.startedAtIso;

    expect(evaluateD12Comparison(evidence)).toContain(
      "d12 sequence 2 overlaps or precedes the prior run",
    );
  });

  it("binds candidate source and harness digests to comparison and top-level evidence", () => {
    const evidence = editorEvidence();
    evidence.sourceTreeSha256 = "e".repeat(64);
    evidence.d12Comparison.measurementHarnessSha256 = "f".repeat(64);

    const failures = evaluateD12Comparison(evidence).join("\n");
    expect(failures).toMatch(/candidateSourceTreeSha256 must match top-level evidence/u);
    expect(failures).toMatch(/bundle toolchain digest does not match comparison/u);
  });

  it.each([
    ["artifact", (cap) => delete cap.artifactSha256, /artifactSha256 is not a lowercase/u],
    [
      "source",
      (cap) => (cap.sourceTreeSha256 = "e".repeat(64)),
      /sourceTreeSha256 does not match candidate/u,
    ],
    [
      "harness",
      (cap) => (cap.measurementHarnessSha256 = "e".repeat(64)),
      /measurementHarnessSha256 does not match candidate/u,
    ],
    ["sequence", (cap) => (cap.sequence = 99), /sequence does not match candidate/u],
    ["start", (cap) => delete cap.startedAtIso, /startedAtIso is not parseable/u],
    ["completion", (cap) => delete cap.completedAtIso, /completedAtIso is not parseable/u],
  ])("requires candidate cap binding field %s", (_field, mutate, expected) => {
    const evidence = editorEvidence();
    mutate(evidence.d12Comparison.repetitions[0].candidate.metrics.capScenarios);

    expect(evaluateD12Comparison(evidence).join("\n")).toMatch(expected);
  });

  it("requires cap execution to follow common measurement and close the candidate interval", () => {
    const evidence = editorEvidence();
    const candidate = evidence.d12Comparison.repetitions[0].candidate;
    candidate.metrics.capScenarios.startedAtIso = d12Timestamp(2, 1);
    candidate.metrics.capScenarios.completedAtIso = d12Timestamp(2, 3);

    const failures = evaluateD12Comparison(evidence).join("\n");
    expect(failures).toMatch(/startedAtIso precedes the common measurement completion/u);
    expect(failures).toMatch(/completedAtIso does not close the candidate interval/u);
  });
});

describe("performance measurement subject", () => {
  it("produces a deterministic lowercase SHA-256 independent of Git path order", () => {
    const files = {
      "package-lock.json": "lockfile-v1",
      "packages/keiko-ui/src/app.tsx": "export const app = 'keiko';\n",
    };
    const paths = Object.keys(files);

    expect(performanceSubjectDigest(files, [...paths].reverse())).toBe(
      performanceSubjectDigest(files, paths),
    );
    expect(performanceSubjectDigest(files)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    "package-lock.json",
    "tsconfig.build.json",
    "packages/keiko-contracts/src/dap-debug.ts",
    "packages/keiko-editor/src/components/editor-model-registry.ts",
    "packages/keiko-server/src/editor/dap/dapDebugRoutes.ts",
    "packages/keiko-ui/src/app.tsx",
    "src/cli/index.ts",
  ])("includes measured product surface %s", (path) => {
    expect(isPerformanceSubjectPath(path)).toBe(true);
  });

  // ADR-0139 D2: repository tooling, workflows, docs, and test-only files cannot alter the
  // measured product and no longer invalidate committed evidence; the measurement toolchain is
  // bound separately through measurementHarnessSha256.
  it.each([
    ".github/workflows/e2e-extended.yml",
    "package.json",
    "docs/release/1209-perf-evidence.json",
    "docs/release/keiko-editor-1209-closure-evidence.md",
    "packages/keiko-server/src/memory-handlers.ts",
    "packages/keiko-ui/dist/index.js",
    "packages/keiko-ui/src/app/components/desktop/AppShell.test.tsx",
    "packages/keiko-ui/src/lib/__tests__/api.test.ts",
    "packages/keiko-ui/vitest.config.ts",
    "playwright-report/results.json",
    "reports/performance.json",
    "scripts/build-ui.mjs",
    "scripts/check-perf-evidence.mjs",
    "scripts/run-d12-perf-comparison.mjs",
    "tests/e2e/editor-performance.spec.ts",
    "tests/fixtures/project/dist/input.js",
    "vitest.config.ts",
  ])("excludes tooling, workflow, doc, output, and test-only path %s", (path) => {
    expect(isPerformanceSubjectPath(path)).toBe(false);
  });

  it("reports untracked, non-ignored performance-subject paths as dirty", () => {
    withTemporaryGitRepository((root) => {
      const sourceRoot = join(root, "packages/keiko-ui/src");
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, "untracked.ts"), "export const untracked = true;\n", "utf8");
      writeFileSync(join(sourceRoot, "ignored.ts"), "export const ignored = true;\n", "utf8");

      const dirtySubjectPaths = listDirtyPerformanceSubjectPaths(root);
      expect(dirtySubjectPaths).toEqual(["packages/keiko-ui/src/untracked.ts"]);
      expect(
        evaluateFreshness(workspaceEvidence(), {
          computeSourceTreeSha256: () => SOURCE_TREE_SHA_256,
          dirtySubjectPaths,
          isAncestor: () => true,
        }).failures,
      ).toContain(
        "performance measurement subject has dirty inputs: packages/keiko-ui/src/untracked.ts",
      );
    });
  });
});

describe("evaluateFreshness", () => {
  it("rejects a D12 document without source-tree binding even while its commit is an ancestor", () => {
    const evidence = editorEvidence();
    delete evidence.freshnessBinding;
    const result = evaluateFreshness(evidence, {
      computeBaselineSourceTreeSha256: () => BASELINE_SOURCE_TREE_SHA_256,
      computeLockfileSha256: () => "a".repeat(64),
      computeMeasurementHarnessSha256: () => MEASUREMENT_HARNESS_SHA_256,
      computeSourceTreeSha256: () => SOURCE_TREE_SHA_256,
      isAncestor: () => true,
    });

    expect(result.failures).toContain("D12 evidence freshnessBinding must be source-tree-v1");
  });

  const isAncestor = () => true;
  const computeMatchingSourceTreeSha256 = () => SOURCE_TREE_SHA_256;

  it("recomputes and rejects a source-tree mismatch even for ancestor evidence", () => {
    const currentDigest = "c".repeat(64);
    const result = evaluateFreshness(workspaceEvidence(), {
      computeSourceTreeSha256: () => currentDigest,
      isAncestor,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      `sourceTreeSha256 ${SOURCE_TREE_SHA_256} != current ${currentDigest} (stale performance evidence)`,
    );
  });

  it("accepts ancestor evidence only when its source-tree digest is current", () => {
    expect(
      evaluateFreshness(workspaceEvidence(), {
        computeSourceTreeSha256: computeMatchingSourceTreeSha256,
        isAncestor,
      }),
    ).toEqual({ passed: true, failures: [] });
  });

  it("fails a missing commit stamp", () => {
    const evidence = workspaceEvidence();
    delete evidence.commit;
    const result = evaluateFreshness(evidence, {
      computeSourceTreeSha256: computeMatchingSourceTreeSha256,
      isAncestor,
    });
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/missing a valid `commit`/u);
  });

  it("fails a missing source-tree digest even for an ancestor", () => {
    const evidence = workspaceEvidence();
    delete evidence.sourceTreeSha256;

    expect(evaluateFreshness(evidence, { isAncestor }).failures).toContain(
      "evidence missing a valid lowercase `sourceTreeSha256` — regenerate the perf suite to stamp freshness",
    );
  });

  it("rejects a foreign commit even when the measurement subject is byte-identical", () => {
    const files = {
      "package-lock.json": "lockfile-v1",
      "packages/keiko-ui/src/app.tsx": "export const app = 'keiko';\n",
    };
    const sourceTreeSha256 = performanceSubjectDigest(files);
    const evidence = workspaceEvidence();
    evidence.sourceTreeSha256 = sourceTreeSha256;

    expect(
      evaluateFreshness(evidence, {
        computeSourceTreeSha256: () => performanceSubjectDigest(files),
        isAncestor: () => false,
      }).failures,
    ).toContain(
      `evidence commit ${evidence.commit} is not reachable from HEAD (stale/foreign-branch evidence)`,
    );
  });

  it("accepts a squash-only source commit with the explicit exact-tree freshness binding", () => {
    const files = { "packages/keiko-ui/src/app.tsx": "measured\n" };
    const evidence = workspaceEvidence();
    evidence.freshnessBinding = "source-tree-v1";
    evidence.sourceTreeSha256 = performanceSubjectDigest(files);

    expect(
      evaluateFreshness(evidence, {
        computeSourceTreeSha256: () => performanceSubjectDigest(files),
        isAncestor: () => false,
      }),
    ).toEqual({ passed: true, failures: [] });
  });

  it("does not let the squash-stable binding hide source-tree drift", () => {
    const evidence = workspaceEvidence();
    evidence.freshnessBinding = "source-tree-v1";
    evidence.sourceTreeSha256 = performanceSubjectDigest({
      "packages/keiko-ui/src/app.tsx": "measured\n",
    });

    const result = evaluateFreshness(evidence, {
      computeSourceTreeSha256: () =>
        performanceSubjectDigest({ "packages/keiko-ui/src/app.tsx": "changed\n" }),
      isAncestor: () => false,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/sourceTreeSha256 .* != current/u);
  });

  it("fails a foreign commit after a one-byte tracked subject drift", () => {
    const measuredFiles = { "packages/keiko-ui/src/app.tsx": "measured\n" };
    const currentFiles = { "packages/keiko-ui/src/app.tsx": "measured!\n" };
    const evidence = workspaceEvidence();
    evidence.sourceTreeSha256 = performanceSubjectDigest(measuredFiles);

    const result = evaluateFreshness(evidence, {
      computeSourceTreeSha256: () => performanceSubjectDigest(currentFiles),
      isAncestor: () => false,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/sourceTreeSha256 .* != current/u);
  });

  it("keeps the subject stable across generated evidence-only changes", () => {
    const trackedPaths = [
      "packages/keiko-ui/src/app.tsx",
      "docs/release/1209-perf-evidence.json",
      "docs/release/keiko-editor-1209-closure-evidence.md",
    ];
    const before = performanceSubjectDigest(
      {
        "packages/keiko-ui/src/app.tsx": "stable source\n",
        "docs/release/1209-perf-evidence.json": '{"run":1}\n',
        "docs/release/keiko-editor-1209-closure-evidence.md": "first closure\n",
      },
      trackedPaths,
    );
    const after = performanceSubjectDigest(
      {
        "packages/keiko-ui/src/app.tsx": "stable source\n",
        "docs/release/1209-perf-evidence.json": '{"run":2}\n',
        "docs/release/keiko-editor-1209-closure-evidence.md": "updated closure\n",
      },
      trackedPaths,
    );

    expect(after).toBe(before);
  });

  it("fails when a relevant tracked path was omitted from the recorded subject", () => {
    const files = {
      "package-lock.json": "lockfile-v1",
      "packages/keiko-ui/src/new-performance-path.ts": "export const relevant = true;\n",
    };
    const evidence = workspaceEvidence();
    evidence.sourceTreeSha256 = performanceSubjectDigest(files, ["package-lock.json"]);

    expect(isPerformanceSubjectPath("packages/keiko-ui/src/new-performance-path.ts")).toBe(true);
    expect(
      evaluateFreshness(evidence, {
        computeSourceTreeSha256: () => performanceSubjectDigest(files),
        isAncestor: () => false,
      }).passed,
    ).toBe(false);
  });

  it("makes the matching D12 candidate fail the current-tree check across a squash", () => {
    const evidence = editorEvidence();
    const currentDigest = "c".repeat(64);

    expect(evaluateD12Comparison(evidence)).toEqual([]);
    const failures = evaluateFreshness(evidence, {
      computeBaselineSourceTreeSha256: () => BASELINE_SOURCE_TREE_SHA_256,
      computeSourceTreeSha256: () => currentDigest,
      isAncestor: () => false,
    }).failures;
    expect(failures.join("\n")).not.toMatch(/stale\/foreign-branch evidence/u);
    expect(failures).toContain(
      `sourceTreeSha256 ${SOURCE_TREE_SHA_256} != current ${currentDigest} ` +
        "(stale performance evidence)",
    );
  });

  it("accepts D12 freshness only when the committed toolchain digest matches", () => {
    const result = evaluateFreshness(editorEvidence(), {
      computeBaselineSourceTreeSha256: () => BASELINE_SOURCE_TREE_SHA_256,
      computeLockfileSha256: () => "a".repeat(64),
      computeMeasurementHarnessSha256: () => MEASUREMENT_HARNESS_SHA_256,
      computeSourceTreeSha256: computeMatchingSourceTreeSha256,
      isAncestor,
    });

    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("rejects D12 evidence generated by stale committed toolchain bytes", () => {
    const currentDigest = "e".repeat(64);
    const result = evaluateFreshness(editorEvidence(), {
      computeBaselineSourceTreeSha256: () => BASELINE_SOURCE_TREE_SHA_256,
      computeLockfileSha256: () => "a".repeat(64),
      computeMeasurementHarnessSha256: () => currentDigest,
      computeSourceTreeSha256: computeMatchingSourceTreeSha256,
      isAncestor,
    });

    expect(result.failures).toContain(
      `measurementHarnessSha256 ${MEASUREMENT_HARNESS_SHA_256} != current committed ${currentDigest} ` +
        "(stale D12 measurement toolchain evidence)",
    );
  });

  it("rejects D12 evidence provisioned from a stale current package-lock", () => {
    const currentDigest = "f".repeat(64);
    const result = evaluateFreshness(editorEvidence(), {
      computeBaselineSourceTreeSha256: () => BASELINE_SOURCE_TREE_SHA_256,
      computeLockfileSha256: () => currentDigest,
      computeMeasurementHarnessSha256: () => MEASUREMENT_HARNESS_SHA_256,
      computeSourceTreeSha256: computeMatchingSourceTreeSha256,
      isAncestor,
    });

    expect(result.failures).toContain(
      `dependencyProvisioning.lockfileSha256 ${"a".repeat(64)} != current ${currentDigest} ` +
        "(stale D12 dependency evidence)",
    );
  });

  it("fails local freshness when a performance-subject input is dirty", () => {
    const result = evaluateFreshness(workspaceEvidence(), {
      computeSourceTreeSha256: computeMatchingSourceTreeSha256,
      dirtySubjectPaths: ["docs/release/1209-perf-evidence.json", "packages/keiko-ui/src/app.tsx"],
      isAncestor,
    });

    expect(result.failures).toContain(
      "performance measurement subject has dirty inputs: packages/keiko-ui/src/app.tsx",
    );
  });

  it("fails an unparseable measuredAtIso", () => {
    const result = evaluateFreshness(
      { ...workspaceEvidence(), measuredAtIso: "not-a-date" },
      {
        computeSourceTreeSha256: computeMatchingSourceTreeSha256,
        isAncestor,
      },
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/measuredAtIso/u);
  });
});
