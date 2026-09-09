import { describe, expect, it } from "vitest";
import {
  buildCodingPerformanceEvidence,
  calibrationBudgets,
  evaluateCodingPerformanceEvidence,
  sealCodingPerformanceDocument,
} from "../coding-runtime-performance-evidence.mjs";

function input() {
  return {
    role: "calibration",
    measuredAtIso: "2026-09-04T00:00:00.000Z",
    subject: {
      commit: "a".repeat(40),
      sourceTreeSha256: "b".repeat(64),
      lockfileSha256: "c".repeat(64),
    },
    measurementHarnessSha256: "d".repeat(64),
    environment: {
      platform: "darwin",
      architecture: "arm64",
      osRelease: "25.6.0",
      logicalCores: 16,
      totalMemoryBytes: 68_719_476_736,
      cpuModelSha256: "e".repeat(64),
      nodeVersion: "24.18.0",
      npmVersion: "11.16.0",
      gitVersion: "2.50.1",
      runtimeVersion: "1.17.17",
      payloadSha256: "f".repeat(64),
      secureReadSha256: "1".repeat(64),
    },
    samples: Array.from({ length: 30 }, (_, index) => ({
      coldStartMs: 100 + index,
      readinessMs: 1 + index / 10,
      sseFirstByteMs: 2 + index / 10,
      boundedThroughputMs: 30 + index,
      observedChunks: 64,
      observedChars: 2048,
      gatewayCalls: 1,
      observedOutputChars: 2048,
    })),
  };
}

function fixture() {
  const calibration = buildCodingPerformanceEvidence(input());
  const budget = calibrationBudgets(calibration);
  const evidence = buildCodingPerformanceEvidence({
    ...input(),
    role: "measurement",
    calibrationSha256: calibration.documentSha256,
  });
  return { calibration, budget, evidence };
}

describe("coding-runtime performance ruler", () => {
  it("derives the p95 with the existing nearest-rank ruler and budgets from observed spread", () => {
    const { calibration, budget, evidence } = fixture();
    expect(calibration.aggregates.coldStartMs).toEqual({
      minimum: 100,
      maximum: 129,
      p50: 114,
      p95: 128,
    });
    expect(budget.maximumP95Ms.coldStartMs).toBe(158);
    expect(evaluateCodingPerformanceEvidence(evidence, calibration, budget)).toEqual({
      defects: [],
      verdicts: [],
    });
  });

  it("publishes an authentic slow measurement and leaves its verdict to the judge", () => {
    const { calibration, budget } = fixture();
    const source = input();
    const evidence = buildCodingPerformanceEvidence({
      ...source,
      role: "measurement",
      calibrationSha256: calibration.documentSha256,
      samples: source.samples.map((sample) => ({
        ...sample,
        coldStartMs: sample.coldStartMs + 1000,
      })),
    });
    const findings = evaluateCodingPerformanceEvidence(evidence, calibration, budget);
    expect(findings.defects).toEqual([]);
    expect(findings.verdicts).toEqual(["coldStartMs exceeds the calibrated p95 budget"]);
  });

  it.each(["prompt", "path", "apiKey"])(
    "refuses extra content-bearing %s fields even under a recomputed seal",
    (key) => {
      const { calibration, budget, evidence } = fixture();
      const altered = sealCodingPerformanceDocument({ ...evidence, [key]: "private" });
      expect(evaluateCodingPerformanceEvidence(altered, calibration, budget).defects).not.toEqual(
        [],
      );
    },
  );

  it.each(["coldStartMs", "readinessMs", "sseFirstByteMs", "boundedThroughputMs"])(
    "does not accept forged %s aggregates",
    (metric) => {
      const { calibration, budget, evidence } = fixture();
      evidence.aggregates[metric].p95 = 0.1;
      expect(
        evaluateCodingPerformanceEvidence(
          sealCodingPerformanceDocument(evidence),
          calibration,
          budget,
        ).defects,
      ).not.toEqual([]);
    },
  );

  it.each([NaN, Infinity, -1, 0])("rejects invalid timing %s before writing", (value) => {
    const source = input();
    source.samples[0].coldStartMs = value;
    expect(() => buildCodingPerformanceEvidence(source)).toThrow();
  });

  it("refuses short sampling, incomplete throughput, and missing output causality", () => {
    const short = input();
    short.samples.pop();
    expect(() => buildCodingPerformanceEvidence(short)).toThrow();
    const incomplete = input();
    incomplete.samples[0].observedOutputChars = 0;
    expect(() => buildCodingPerformanceEvidence(incomplete)).toThrow();
  });

  it("rejects a foreign reference environment even if its timings are fast", () => {
    const { calibration, budget, evidence } = fixture();
    evidence.environment.logicalCores = 4;
    expect(
      evaluateCodingPerformanceEvidence(
        sealCodingPerformanceDocument(evidence),
        calibration,
        budget,
      ).defects,
    ).toContain("reference environment differs from calibration");
  });

  it("refuses a different ruler even when environment and timings match", () => {
    const { calibration, budget, evidence } = fixture();
    evidence.measurementHarnessSha256 = "9".repeat(64);
    expect(
      evaluateCodingPerformanceEvidence(
        sealCodingPerformanceDocument(evidence),
        calibration,
        budget,
      ).defects,
    ).toContain("measurement ruler differs from calibration");
  });

  it("refuses impossible timestamps and an overflowing calibration ceiling", () => {
    expect(() =>
      buildCodingPerformanceEvidence({ ...input(), measuredAtIso: "2026-02-30T00:00:00.000Z" }),
    ).toThrow();
    const source = input();
    source.samples[0].coldStartMs = Number.MAX_VALUE;
    expect(() => calibrationBudgets(buildCodingPerformanceEvidence(source))).toThrow(
      "calibrated ceiling",
    );
  });

  it("cannot hide calibration tampering by regenerating its document seal", () => {
    const { calibration, budget, evidence } = fixture();
    const source = input();
    source.samples[0].coldStartMs += 500;
    const changed = buildCodingPerformanceEvidence(source);
    expect(evaluateCodingPerformanceEvidence(evidence, changed, budget).defects).toContain(
      "calibration anchor differs from reviewed budget",
    );
    expect(calibration.documentSha256).not.toBe(changed.documentSha256);
  });

  it("preserves both a defect and a budget verdict", () => {
    const { calibration, budget } = fixture();
    const source = input();
    source.samples = source.samples.map((sample) => ({ ...sample, coldStartMs: 1000 }));
    const evidence = buildCodingPerformanceEvidence({
      ...source,
      role: "measurement",
      calibrationSha256: "0".repeat(64),
    });
    const result = evaluateCodingPerformanceEvidence(evidence, calibration, budget);
    expect(result.defects).not.toEqual([]);
    expect(result.verdicts).not.toEqual([]);
  });
});
