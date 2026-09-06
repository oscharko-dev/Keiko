import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeQualificationEvidenceReceipt } from "../lib/qualification-evidence-receipt.mjs";
import { readReceipts } from "../check-coding-issue-journey-evidence.mjs";
import { codingIssueJourneyScenarioArtifactErrors } from "../lib/coding-issue-journey-scenario-evidence.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function receipt(assertions) {
  return {
    schemaVersion: 1,
    scenarioId: "git-chat-negative-effects",
    evidenceClass: "playwright-journey",
    sourceCommitSha: "a".repeat(40),
    platformTarget: "macos-arm64",
    result: "failed",
    assertions,
    usage: {
      spendObservability: "unknown",
      observedToolCallEvents: 0,
      observedRunDurationMs: 5,
    },
  };
}

describe("writeQualificationEvidenceReceipt strict journey artifacts", () => {
  it("rejects a raw failure message before writing either evidence file", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    roots.push(root);

    expect(() =>
      writeQualificationEvidenceReceipt({
        receiptsDir: root,
        scenarioId: "git-chat-negative-effects",
        receipt: receipt(["error:/private/tmp/repository secret provider response"]),
        recordedAt: "2026-09-06T08:00:00.000Z",
      }),
    ).toThrow("invalid coding-issue journey scenario artifact");
    expect(existsSync(join(root, "git-chat-negative-effects.artifact"))).toBe(false);
    expect(existsSync(join(root, "git-chat-negative-effects.receipt.json"))).toBe(false);
  });

  it.each([
    [
      "issue-to-pr-governed-assist",
      [
        "real-model-run-recorded:run-123",
        "draft-pull-request-created:oscharko/Wegwerf-Repo#7",
        "mode-selected:governed-assist",
      ],
    ],
    [
      "ci-repair-loop",
      [
        "ci-terminal-state:ready",
        "observed-failure-before-ready:true",
        "required-checks-total:2",
        "repair-head-changed:true",
        "ci-repair-evidence:observed-failure-repaired-fresh-head-ready",
      ],
    ],
    [
      "description-auto-draft-and-apply",
      [
        "auto-draft-reason:generated",
        "retained-proposal:proposal-1",
        "governed-apply-completed:true",
      ],
    ],
    ["mark-ready-intent", ["ready-for-review-proposed:true"]],
    [
      "git-to-chat-connect-refine-apply",
      [
        "git-change-chat-connected:true",
        "refined-over-turns:2",
        "governed-apply-completed:true",
        "no-forbidden-session-requests:true",
        "no-forbidden-session-tool-events:true",
      ],
    ],
    [
      "git-chat-negative-effects",
      ["malformed-effect-requests-rejected:9", "no-mutating-chat-controls-among:4"],
    ],
  ])("accepts the current closed %s success assertions", (scenarioId, assertions) => {
    expect(
      codingIssueJourneyScenarioArtifactErrors(
        { ...receipt(assertions), scenarioId, result: "passed" },
        scenarioId,
      ),
    ).toEqual([]);
  });

  it("accepts only the closed failed-scenario assertion", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    roots.push(root);
    expect(() =>
      writeQualificationEvidenceReceipt({
        receiptsDir: root,
        scenarioId: "git-chat-negative-effects",
        receipt: receipt(["scenario-execution-failed:true"]),
        recordedAt: "2026-09-06T08:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("makes the evidence reader retain semantic failures from the artifact bytes it hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    roots.push(root);
    const scenarioId = "git-chat-negative-effects";
    writeFileSync(
      join(root, `${scenarioId}.artifact`),
      `${JSON.stringify({ ...receipt(["passed:true"]), result: "passed" })}\n`,
    );
    writeFileSync(
      join(root, `${scenarioId}.receipt.json`),
      `${JSON.stringify({
        scenarioId,
        commitSha: "a".repeat(40),
        platform: "macos-arm64",
        testStatus: "passed",
        recordedAt: "2026-09-06T08:00:00.000Z",
        provenance: "real-model",
      })}\n`,
    );

    expect(readReceipts(root).get(scenarioId)?.artifactValidationErrors).toEqual([
      "passed scenario assertions do not match the scenario contract",
    ]);
  });
});
