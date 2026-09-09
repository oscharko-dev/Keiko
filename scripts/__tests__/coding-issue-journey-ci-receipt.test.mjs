import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCiRepairScenario } from "../../tests/e2e/support/coding-issue-journey-live-runners.js";
import { writeQualificationEvidenceReceipt } from "../lib/qualification-evidence-receipt.mjs";

vi.mock("../../tests/e2e/support/coding-issue-journey-live-cache.js", () => ({
  driveOrReuseDraftPullRequest: vi.fn(async () => undefined),
}));
vi.mock("../../tests/e2e/support/coding-issue-journey-live-ci.js", async (importOriginal) => ({
  ...(await importOriginal()),
  waitForCiRepairOutcome: vi.fn(async () => ({
    finalState: "technical-ready",
    observedFailureBeforeReady: true,
    requiredChecks: { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 },
    failureHeadSha: "a".repeat(40),
    finalHeadSha: "b".repeat(40),
  })),
}));

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CI repair qualification receipt production boundary", () => {
  it("accepts the successful real scenario runner's own assertions without rewriting its state", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-ci-receipt-"));
    roots.push(root);
    vi.stubEnv("KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT", root);
    vi.stubEnv("KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE", "#1");
    const result = await runCiRepairScenario({});
    const receipt = {
      schemaVersion: 1,
      scenarioId: "ci-repair-loop",
      evidenceClass: "playwright-journey",
      sourceCommitSha: "c".repeat(40),
      platformTarget: "macos-arm64",
      result: "passed",
      assertions: result.assertions,
      usage: {
        spendObservability: "unknown",
        observedToolCallEvents: 0,
        observedRunDurationMs: 1,
      },
    };
    writeQualificationEvidenceReceipt({
      receiptsDir: root,
      scenarioId: receipt.scenarioId,
      receipt,
      recordedAt: "2026-09-06T10:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(join(root, "ci-repair-loop.artifact"), "utf8"))).toEqual(
      receipt,
    );
  });
});
