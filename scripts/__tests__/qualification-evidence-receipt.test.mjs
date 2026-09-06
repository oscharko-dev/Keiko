import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("rejects a self-declared passing performance artifact without native evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    roots.push(root);
    expect(() =>
      writeQualificationEvidenceReceipt({
        receiptsDir: root,
        scenarioId: "coding-runtime-performance-budgets",
        recordedAt: "2026-09-06T08:00:00.000Z",
        provenance: "production-functional",
        receipt: {
          schemaVersion: 1,
          scenarioId: "coding-runtime-performance-budgets",
          evidenceClass: "production-functional",
          sourceCommitSha: "a".repeat(40),
          platformTarget: "macos-arm64",
          result: "passed",
        },
      }),
    ).toThrow("invalid coding-issue journey scenario artifact");
  });

  it("rejects a self-declared passing real-binary artifact without the complete run proof", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    roots.push(root);
    expect(() =>
      writeQualificationEvidenceReceipt({
        receiptsDir: root,
        scenarioId: "real-binary-lane",
        recordedAt: "2026-09-06T08:00:00.000Z",
        provenance: "production-functional",
        receipt: {
          schemaVersion: 1,
          evidenceKind: "keiko-code-task-real-binary-v1",
          scenarioId: "real-binary-lane",
          evidenceClass: "production-functional",
          sourceCommitSha: "a".repeat(40),
          platformTarget: "macos-arm64",
          result: "passed",
        },
      }),
    ).toThrow("invalid coding-issue journey scenario artifact");
  });

  it("writes a distinct flow-qualified key without changing the canonical scenario identity", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    roots.push(root);
    const scenarioId = "git-chat-negative-effects";
    const receiptKey = `issue-to-pr-flow-01.${scenarioId}`;
    const digest = writeQualificationEvidenceReceipt({
      receiptsDir: root,
      scenarioId,
      receiptKey,
      receipt: receipt(["scenario-execution-failed:true"]),
      recordedAt: "2026-09-06T08:00:00.000Z",
    });

    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      JSON.parse(readFileSync(join(root, `${receiptKey}.receipt.json`), "utf8")),
    ).toMatchObject({
      scenarioId,
    });
    expect(existsSync(join(root, `${receiptKey}.artifact`))).toBe(true);
    expect(existsSync(join(root, `${scenarioId}.artifact`))).toBe(false);
  });

  it("rejects a receipt key that can escape the evidence directory", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-journey-receipt-"));
    roots.push(root);
    expect(() =>
      writeQualificationEvidenceReceipt({
        receiptsDir: root,
        scenarioId: "git-chat-negative-effects",
        receiptKey: "../foreign",
        receipt: receipt(["scenario-execution-failed:true"]),
        recordedAt: "2026-09-06T08:00:00.000Z",
      }),
    ).toThrow("invalid qualification evidence receipt key");
  });

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
      "description-auto-draft-and-apply",
      [
        "auto-draft-reason:generated",
        "retained-proposal:proposal-1",
        "governed-apply-completed:true",
      ],
    ],
    ["mark-ready-intent", ["ready-for-review-proposed:true"]],
    [
      "human-merge-and-closure",
      [
        "governed-merge-confirmed:true",
        "provider-merge-observed:true",
        "bound-issue-closure-observed:true",
      ],
    ],
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
    const flowBinding = {
      flowId: "issue-to-pr-flow-05",
      taskRunId: "run-5",
      repository: "oscharko/Wegwerf-Repo",
      issueNumber: 6,
      pullRequestNumber: 11,
      pullRequestHeadSha: "c".repeat(40),
      mergeCommitSha: "b".repeat(40),
    };
    expect(
      codingIssueJourneyScenarioArtifactErrors(
        {
          ...receipt(assertions),
          scenarioId,
          result: "passed",
          ...(scenarioId === "human-merge-and-closure"
            ? { usage: { ...receipt(assertions).usage, observedToolCallEvents: 1 } }
            : {}),
          ...(scenarioId === "human-merge-and-closure" ? { flowBinding } : {}),
        },
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
