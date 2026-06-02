import { describe, expect, it } from "vitest";
import { buildEvidenceReport, renderEvidenceReport } from "../../src/audit/report.js";
import type { EvidenceManifest } from "../../src/audit/types.js";

function manifest(over: Partial<EvidenceManifest> = {}): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId: "run-1",
      fingerprint: "fp-xyz",
      harnessVersion: "0.1.3",
      taskType: "investigate-bug",
      outcome: "completed",
      startedAt: 100,
      finishedAt: 250,
      durationMs: 150,
    },
    model: { modelId: "m1", costClass: "medium" },
    usageTotals: { promptTokens: 12, completionTokens: 6, requestCount: 2, totalLatencyMs: 80 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    ...over,
  };
}

describe("buildEvidenceReport", () => {
  it("populates every field from the manifest and location", () => {
    const report = buildEvidenceReport(manifest(), "/repo/.keiko/evidence/run-1.json");
    expect(report).toMatchObject({
      evidenceLocation: "/repo/.keiko/evidence/run-1.json",
      runId: "run-1",
      fingerprint: "fp-xyz",
      taskType: "investigate-bug",
      outcome: "completed",
      changedFiles: 0,
      costClass: "medium",
      verificationStatus: "not-run",
    });
    expect(report.usageTotals.promptTokens).toBe(12);
    expect(report.knownLimitations.length).toBeGreaterThan(0);
  });

  it("reflects patch changedFiles and verification status when present", () => {
    const report = buildEvidenceReport(
      manifest({
        patch: {
          proposed: true,
          applied: true,
          targetFileCount: 2,
          patchBytes: 10,
          changedFiles: 3,
          created: 1,
          deleted: 0,
        },
        verification: {
          workspaceRoot: "/repo",
          overallStatus: "passed",
          durationMs: 5,
          counts: {
            passed: 1,
            failed: 0,
            skipped: 0,
            denied: 0,
            "timed-out": 0,
            cancelled: 0,
            "resource-exceeded": 0,
          },
          results: [],
        },
      }),
      "/repo/.keiko/evidence/run-1.json",
    );
    expect(report.changedFiles).toBe(3);
    expect(report.verificationStatus).toBe("passed");
  });

  it("derives verification status from harness verification events when no #7 summary exists", () => {
    const report = buildEvidenceReport(
      manifest({
        verificationResults: [
          { seq: 1, ts: 100, passed: true, detail: "ok" },
          { seq: 2, ts: 110, passed: false, detail: "not ok" },
        ],
      }),
      "/repo/.keiko/evidence/run-1.json",
    );
    expect(report.verificationStatus).toBe("failed");
  });
});

describe("renderEvidenceReport", () => {
  it("renders a human-readable text block containing the key fields", () => {
    const text = renderEvidenceReport(
      buildEvidenceReport(manifest(), "/repo/.keiko/evidence/run-1.json"),
    );
    expect(text).toContain("run-1");
    expect(text).toContain("fp-xyz");
    expect(text).toContain("investigate-bug");
    expect(text).toContain("/repo/.keiko/evidence/run-1.json");
    expect(text).toContain("medium");
  });
});
