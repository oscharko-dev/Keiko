import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCodingPerformanceEvidence } from "../coding-runtime-performance-evidence.mjs";
import {
  buildCodingIssueJourneyPerformanceArtifact,
  codingIssueJourneyPerformanceArtifactErrors,
} from "../lib/coding-issue-journey-functional-evidence.mjs";
import { writeQualificationEvidenceReceipt } from "../lib/qualification-evidence-receipt.mjs";

function fixture() {
  const measurement = JSON.parse(
    readFileSync(resolve("docs/release/2952-coding-runtime-perf-evidence.json"), "utf8"),
  );
  return {
    source: { ...measurement.subject, commit: "c".repeat(40) },
    measurementHarnessSha256: measurement.measurementHarnessSha256,
    measurement,
    calibration: JSON.parse(
      readFileSync(resolve("docs/release/2952-coding-runtime-calibration.json"), "utf8"),
    ),
    budget: JSON.parse(
      readFileSync(resolve("scripts/coding-runtime-performance-budget.json"), "utf8"),
    ),
  };
}

describe("coding-issue native performance evidence", () => {
  it("rejects an arbitrary passed claim at the existing receipt writer", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-performance-receipt-"));
    try {
      expect(() =>
        writeQualificationEvidenceReceipt({
          receiptsDir: directory,
          scenarioId: "coding-runtime-performance-budgets",
          receipt: {
            result: "passed",
            sourceCommitSha: "a".repeat(40),
            platformTarget: "macos-arm64",
          },
          recordedAt: "2026-09-06T00:00:00.000Z",
          provenance: "production-functional",
        }),
      ).toThrow("invalid coding-issue journey scenario artifact");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains the original native measurement commit and verifies the unchanged measured subject", () => {
    const input = fixture();
    const artifact = buildCodingIssueJourneyPerformanceArtifact(input);
    expect(codingIssueJourneyPerformanceArtifactErrors(artifact)).toEqual([]);
    expect(artifact.sourceCommitSha).toBe(input.source.commit);
    expect(artifact.measurement.subject.commit).toBe(input.measurement.subject.commit);
    expect(artifact.measurement.subject.commit).not.toBe(artifact.sourceCommitSha);
  });

  it.each(["sourceTreeSha256", "lockfileSha256"])("rejects changed measured %s", (field) => {
    const input = fixture();
    input.source[field] = "f".repeat(64);
    expect(() => buildCodingIssueJourneyPerformanceArtifact(input)).toThrow("stale");
  });

  it("rejects changed ruler bytes and extra content-bearing fields", () => {
    const input = fixture();
    expect(() =>
      buildCodingIssueJourneyPerformanceArtifact({
        ...input,
        measurementHarnessSha256: "f".repeat(64),
      }),
    ).toThrow("stale");
    const artifact = buildCodingIssueJourneyPerformanceArtifact(input);
    expect(
      codingIssueJourneyPerformanceArtifactErrors({ ...artifact, prompt: "private" }),
    ).not.toEqual([]);
    expect(
      codingIssueJourneyPerformanceArtifactErrors({
        ...artifact,
        measurement: { ...artifact.measurement, path: "private" },
      }),
    ).not.toEqual([]);
  });

  it("refuses a genuinely over-budget measurement evaluated by the owning producer and judge", () => {
    const input = fixture();
    const { measurement } = input;
    const slow = buildCodingPerformanceEvidence({
      role: measurement.role,
      measuredAtIso: measurement.measuredAtIso,
      subject: measurement.subject,
      environment: measurement.environment,
      measurementHarnessSha256: measurement.measurementHarnessSha256,
      calibrationSha256: measurement.calibrationSha256,
      samples: measurement.samples.map((sample) => ({
        ...sample,
        coldStartMs: sample.coldStartMs + input.budget.maximumP95Ms.coldStartMs,
      })),
    });
    expect(() =>
      buildCodingIssueJourneyPerformanceArtifact({ ...input, measurement: slow }),
    ).toThrow("over budget");
  });
});
