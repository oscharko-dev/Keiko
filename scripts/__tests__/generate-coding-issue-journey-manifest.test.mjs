// Unit coverage for the pure projection (scripts/lib/coding-issue-journey-manifest.mjs) plus an
// end-to-end test of the CLI wrapper itself (scripts/generate-coding-issue-journey-manifest.mjs),
// mirroring scripts/__tests__/generate-code-task-acceptance.test.mjs's split: the wrapper executes
// at module top level, so each CLI case imports it with a fresh cache-busting query and a prepared
// process.argv.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS } from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";

import { buildCodingIssueJourneyManifest } from "../lib/coding-issue-journey-manifest.mjs";

const SCRIPT_URL = pathToFileURL(
  join(process.cwd(), "scripts", "generate-coding-issue-journey-manifest.mjs"),
).href;
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);
const GENERATED_AT = "2026-09-04T12:00:00Z";

function descriptor() {
  return {
    epicIssue: 3384,
    childIssue: 3390,
    scenarios: [
      {
        scenarioId: "issue-to-pr-full-access",
        evidenceClass: "playwright-journey",
        platform: "macos-arm64",
      },
    ],
    blocked: [
      {
        scenarioId: "packaged-macos-arm64-reference",
        evidenceClass: "packaged-computer-use",
        platform: "macos-arm64",
        blockedReason: "#2198",
      },
    ],
    knownLimitations: ["packaged reference run depends on #2198, which remains open"],
  };
}

describe("buildCodingIssueJourneyManifest", () => {
  it("derives a ran scenario's outcome and digest from its receipt, and a blocked row from the descriptor", () => {
    const receiptsByScenarioId = new Map([
      [
        "issue-to-pr-full-access",
        {
          scenarioId: "issue-to-pr-full-access",
          testStatus: "passed",
          recordedAt: "2026-09-04T11:00:00Z",
          provenance: "real-model",
          digest: DIGEST,
        },
      ],
    ]);
    const manifest = buildCodingIssueJourneyManifest({
      descriptor: descriptor(),
      receiptsByScenarioId,
      generatedAt: GENERATED_AT,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeIdentity: "opencode-1.17.17",
      modelIdentity: "gateway-profile:coding-issue-journey",
      fixtureRevision: "controlled-fixture-rev-1",
      rubricDigest: DIGEST,
      requiredTools: ["keiko_changeset_edit"],
      spendBudgetUsd: 25,
      observedSpendUsd: undefined,
    });
    const ran = manifest.scenarios.find(
      (scenario) => scenario.scenarioId === "issue-to-pr-full-access",
    );
    expect(ran).toMatchObject({
      outcome: "passed",
      provenance: "real-model",
      recordedAt: "2026-09-04T11:00:00Z",
      receiptDigest: { outcome: "known", value: DIGEST },
    });
    const blocked = manifest.scenarios.find(
      (scenario) => scenario.scenarioId === "packaged-macos-arm64-reference",
    );
    expect(blocked).toMatchObject({
      outcome: "blocked",
      recordedAt: GENERATED_AT,
      blockedReason: { outcome: "known", value: "#2198" },
      receiptDigest: { outcome: "absent" },
    });
    expect(manifest.observedSpendUsd).toEqual({ outcome: "unknown" });
    expect(manifest.issueReference).toEqual({ outcome: "unknown" });
  });

  it("records any test status other than passed as a failed outcome", () => {
    const receiptsByScenarioId = new Map([
      [
        "issue-to-pr-full-access",
        {
          scenarioId: "issue-to-pr-full-access",
          testStatus: "skipped",
          recordedAt: "2026-09-04T11:00:00Z",
          provenance: "real-model",
          digest: DIGEST,
        },
      ],
    ]);
    const manifest = buildCodingIssueJourneyManifest({
      descriptor: { ...descriptor(), blocked: [] },
      receiptsByScenarioId,
      generatedAt: GENERATED_AT,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeIdentity: "opencode-1.17.17",
      modelIdentity: "gateway-profile:coding-issue-journey",
      fixtureRevision: "controlled-fixture-rev-1",
      rubricDigest: DIGEST,
      requiredTools: [],
      spendBudgetUsd: 25,
    });
    expect(manifest.scenarios[0].outcome).toBe("failed");
  });

  it("throws when a declared non-blocked scenario has no receipt", () => {
    expect(() =>
      buildCodingIssueJourneyManifest({
        descriptor: { ...descriptor(), blocked: [] },
        receiptsByScenarioId: new Map(),
        generatedAt: GENERATED_AT,
        sourceCommitSha: COMMIT_SHA,
        sourceTreeSha: TREE_SHA,
        runtimeIdentity: "opencode-1.17.17",
        modelIdentity: "gateway-profile:coding-issue-journey",
        fixtureRevision: "controlled-fixture-rev-1",
        rubricDigest: DIGEST,
        requiredTools: [],
        spendBudgetUsd: 25,
      }),
    ).toThrow("missing receipt for issue-to-pr-full-access");
  });

  it("does not derive a merge attestation without a matching completed flow", () => {
    const manifest = buildCodingIssueJourneyManifest({
      descriptor: {
        ...descriptor(),
        scenarios: [
          {
            scenarioId: "human-merge-and-closure",
            evidenceClass: "playwright-journey",
            platform: "macos-arm64",
          },
        ],
        blocked: [],
      },
      receiptsByScenarioId: new Map([
        [
          "human-merge-and-closure",
          {
            testStatus: "passed",
            recordedAt: GENERATED_AT,
            provenance: "real-model",
            digest: "d".repeat(64),
            artifactValidationErrors: [],
            artifactIdentity: {
              flowBinding: {
                flowId: "issue-to-pr-flow-01",
                taskRunId: "run-1",
                repository: "oscharko/Wegwerf-Repo",
                issueNumber: 1,
                pullRequestNumber: 2,
                pullRequestHeadSha: TREE_SHA,
                mergeCommitSha: COMMIT_SHA,
              },
            },
          },
        ],
      ]),
      generatedAt: GENERATED_AT,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeIdentity: "opencode-1.17.17",
      modelIdentity: "gateway-profile:coding-issue-journey",
      fixtureRevision: "controlled-fixture-rev-1",
      rubricDigest: DIGEST,
      humanMergeAttestationDigest: "e".repeat(64),
      requiredTools: [],
      spendBudgetUsd: 25,
    });

    expect(manifest.humanMergeAttestationDigest).toEqual({ outcome: "unknown" });
  });

  it("projects a flow from the exact artifact and receipt digests", () => {
    const artifact = {
      evidenceKind: "code-task-qualification-flow-evidence",
      schemaVersion: 1,
      flowId: "issue-to-pr-flow-01",
      ordinal: 1,
      repository: "oscharko/Wegwerf-Repo",
      issueReference: "https://github.com/oscharko/Wegwerf-Repo/issues/1",
      issueNumber: 1,
      issueState: "closed",
      issueClosedAt: "2026-09-06T05:30:00.000Z",
      mode: "governed-assist",
      taskRunId: "run-1",
      pullRequestReference: "https://github.com/oscharko/Wegwerf-Repo/pull/2",
      pullRequestNumber: 2,
      pullRequestHeadSha: TREE_SHA,
      pullRequestState: "merged",
      pullRequestMergedAt: "2026-09-06T05:29:00.000Z",
      mergeCommitSha: COMMIT_SHA,
      requiredChecks: {
        observation: "observed",
        headSha: TREE_SHA,
        requirementsVersion: "1",
        requirementsDigest: "e".repeat(64),
        evidenceRef: "ci-run-1",
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
      },
      authorityObservation: {
        requestedMode: "governed-assist",
        effectiveMode: "governed-assist",
        approvalRequestCount: 1,
        toolInvocationCount: 2,
        effectStartedCount: 1,
        completedToolCount: 2,
        deniedToolCount: 0,
        failedToolCount: 0,
        otherToolCount: 0,
      },
      rubricReview: {
        reviewId: "review-1",
        reviewDigest: "d".repeat(64),
        verdict: "approved",
        flowId: "issue-to-pr-flow-01",
        taskRunId: "run-1",
        repository: "oscharko/Wegwerf-Repo",
        issueNumber: 1,
        pullRequestNumber: 2,
        pullRequestHeadSha: TREE_SHA,
        sourceCommitSha: COMMIT_SHA,
        rubricDigest: DIGEST,
        criteriaTotal: 5,
        criteriaPassed: 5,
      },
      stageEvidence: {
        issueToPr: {
          scenarioId: "issue-to-pr-governed-assist",
          receiptDigest: "1".repeat(64),
        },
        ciRepair: { scenarioId: "ci-repair-loop", receiptDigest: "2".repeat(64) },
        description: {
          scenarioId: "description-auto-draft-and-apply",
          receiptDigest: "3".repeat(64),
        },
        markReady: { scenarioId: "mark-ready-intent", receiptDigest: "4".repeat(64) },
        governedMerge: {
          scenarioId: "human-merge-and-closure",
          receiptDigest: "5".repeat(64),
        },
      },
      transitions: CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
      sourceCommitSha: COMMIT_SHA,
      observedAt: "2026-09-06T05:31:00.000Z",
      spend: {
        budgetNanoUsd: 50_000_000_000,
        chargedDeltaNanoUsd: 3_240_000,
        cumulativeChargedNanoUsd: 3_240_000,
        remainingNanoUsd: 49_996_760_000,
      },
    };
    const manifest = buildCodingIssueJourneyManifest({
      descriptor: {
        ...descriptor(),
        scenarios: [
          ...descriptor().scenarios,
          {
            scenarioId: "human-merge-and-closure",
            evidenceClass: "playwright-journey",
            platform: "macos-arm64",
          },
        ],
        flows: [{ flowId: artifact.flowId }],
      },
      receiptsByScenarioId: new Map([
        [
          "issue-to-pr-full-access",
          {
            testStatus: "passed",
            recordedAt: GENERATED_AT,
            provenance: "real-model",
            digest: DIGEST,
          },
        ],
        [
          "human-merge-and-closure",
          {
            testStatus: "passed",
            recordedAt: GENERATED_AT,
            provenance: "real-model",
            digest: "e".repeat(64),
            artifactValidationErrors: [],
            artifactIdentity: {
              flowBinding: {
                flowId: artifact.flowId,
                taskRunId: artifact.taskRunId,
                repository: artifact.repository,
                issueNumber: artifact.issueNumber,
                pullRequestNumber: artifact.pullRequestNumber,
                pullRequestHeadSha: artifact.pullRequestHeadSha,
                mergeCommitSha: artifact.mergeCommitSha,
              },
            },
          },
        ],
      ]),
      flowReceiptsById: new Map([
        [
          artifact.flowId,
          {
            artifact,
            platform: "macos-arm64",
            provenance: "real-model",
            recordedAt: GENERATED_AT,
            artifactDigest: "d".repeat(64),
            receiptDigest: "f".repeat(64),
          },
        ],
      ]),
      generatedAt: GENERATED_AT,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeIdentity: "opencode-1.17.17",
      modelIdentity: "gateway-profile:coding-issue-journey",
      fixtureRevision: "controlled-fixture-rev-1",
      rubricDigest: DIGEST,
      requiredTools: [],
      spendBudgetUsd: 50,
      observedSpendUsd: 0.00324,
    });
    expect(manifest.flows[0]).toMatchObject({
      flowId: artifact.flowId,
      artifactDigest: "d".repeat(64),
      receiptDigest: "f".repeat(64),
      spend: artifact.spend,
    });
    expect(manifest.issueReference).toEqual({ outcome: "known", value: artifact.issueReference });
    expect(manifest.pullRequestReference).toEqual({
      outcome: "known",
      value: artifact.pullRequestReference,
    });
    expect(manifest.runReference).toEqual({ outcome: "known", value: artifact.taskRunId });
    expect(manifest.humanMergeAttestationDigest).toEqual({
      outcome: "known",
      value: "e".repeat(64),
    });
  });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const roots = [];
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stageInputs() {
  const root = mkdtempSync(join(tmpdir(), "keiko-coding-issue-journey-manifest-cli-"));
  roots.push(root);
  const descriptorPath = join(root, "descriptor.json");
  writeFileSync(descriptorPath, JSON.stringify(descriptor()), "utf8");
  const rubricPath = join(root, "rubric.md");
  writeFileSync(rubricPath, "rubric text\n", "utf8");
  const receiptsDir = join(root, "receipts");
  return { root, descriptorPath, rubricPath, receiptsDir };
}

function writeReceipt(receiptsDir, { mkdirSync, writeFileSync: write }, scenarioId, bytes) {
  mkdirSync(receiptsDir, { recursive: true });
  write(join(receiptsDir, `${scenarioId}.artifact`), bytes);
  write(
    join(receiptsDir, `${scenarioId}.receipt.json`),
    JSON.stringify({
      scenarioId,
      commitSha: COMMIT_SHA,
      platform: "macos-arm64",
      testStatus: "passed",
      recordedAt: "2026-09-04T11:00:00Z",
      provenance: "real-model",
    }),
  );
}

describe("generate-coding-issue-journey-manifest CLI", () => {
  it("reads the descriptor and receipts directory, validates, and writes the manifest", async () => {
    const { root, descriptorPath, rubricPath, receiptsDir } = stageInputs();
    const { mkdirSync } = await import("node:fs");
    writeReceipt(
      receiptsDir,
      { mkdirSync, writeFileSync },
      "issue-to-pr-full-access",
      Buffer.from("artifact-bytes\n"),
    );
    const outputPath = join(root, "manifest.json");
    process.argv = [
      process.execPath,
      "generate-coding-issue-journey-manifest.mjs",
      "--descriptor",
      descriptorPath,
      "--receipts",
      receiptsDir,
      "--commit",
      COMMIT_SHA,
      "--tree",
      TREE_SHA,
      "--runtime-identity",
      "opencode-1.17.17",
      "--model-identity",
      "gateway-profile:coding-issue-journey",
      "--fixture-revision",
      "controlled-fixture-rev-1",
      "--rubric",
      rubricPath,
      "--required-tools",
      "keiko_changeset_edit,keiko_git_push",
      "--spend-budget-usd",
      "25",
      "--output",
      outputPath,
    ];
    await import(`${SCRIPT_URL}?case=happy`);
    const written = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(written.sourceCommitSha).toBe(COMMIT_SHA);
    expect(written.requiredTools).toEqual(["keiko_changeset_edit", "keiko_git_push"]);
    const ran = written.scenarios.find(
      (scenario) => scenario.scenarioId === "issue-to-pr-full-access",
    );
    expect(ran.outcome).toBe("passed");
    expect(ran.receiptDigest).toEqual({
      outcome: "known",
      value: sha256(Buffer.from("artifact-bytes\n")),
    });
    const blocked = written.scenarios.find(
      (scenario) => scenario.scenarioId === "packaged-macos-arm64-reference",
    );
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockedReason).toEqual({ outcome: "known", value: "#2198" });
  });

  it("fails loudly when a required argument is missing", async () => {
    process.argv = [process.execPath, "generate-coding-issue-journey-manifest.mjs"];
    await expect(import(`${SCRIPT_URL}?case=missing`)).rejects.toThrow(/missing --receipts/u);
  });

  it("fails loudly when the manifest does not validate against the contract", async () => {
    const { root, descriptorPath, rubricPath, receiptsDir } = stageInputs();
    const { mkdirSync } = await import("node:fs");
    writeReceipt(
      receiptsDir,
      { mkdirSync, writeFileSync },
      "issue-to-pr-full-access",
      Buffer.from("artifact-bytes\n"),
    );
    process.argv = [
      process.execPath,
      "generate-coding-issue-journey-manifest.mjs",
      "--descriptor",
      descriptorPath,
      "--receipts",
      receiptsDir,
      "--commit",
      COMMIT_SHA,
      "--tree",
      TREE_SHA,
      "--runtime-identity",
      "opencode-1.17.17",
      "--model-identity",
      "gateway-profile:coding-issue-journey",
      "--fixture-revision",
      "controlled-fixture-rev-1",
      "--rubric",
      rubricPath,
      "--required-tools",
      "not a tool name!",
      "--spend-budget-usd",
      "25",
      "--output",
      join(root, "manifest.json"),
    ];
    await expect(import(`${SCRIPT_URL}?case=invalid`)).rejects.toThrow(
      /requiredTools must be an array of catalog tool names/u,
    );
  });
});
