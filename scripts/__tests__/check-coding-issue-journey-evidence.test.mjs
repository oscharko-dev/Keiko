import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND,
  CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
  codeTaskQualificationManifestFailures,
  codeTaskQualificationVerdictFor,
  validateCodeTaskQualificationFlowArtifact,
  validateCodeTaskQualificationManifest,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";

import {
  checkCodingIssueJourneyEvidence,
  qualificationBinding,
  readFlowReceipts,
  readReceipts,
} from "../check-coding-issue-journey-evidence.mjs";
import {
  canonicalJson,
  deriveGateVerdict,
  evidenceGateFailures,
  platformKeyFor,
} from "../lib/coding-issue-journey-evidence.mjs";
import {
  writeCodingIssueJourneyFlowEvidenceReceipt,
  writeQualificationEvidenceReceipt,
} from "../lib/qualification-evidence-receipt.mjs";
import {
  CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH,
  CODING_ISSUE_JOURNEY_MANIFEST_PATH,
  CODING_ISSUE_JOURNEY_RECEIPTS_PATH,
} from "../lib/coding-issue-journey-source-binding.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";

const GATE_PATH = fileURLToPath(
  new URL("../check-coding-issue-journey-evidence.mjs", import.meta.url),
);

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const HEAD_SHAS = { sourceCommitSha: COMMIT_SHA, sourceTreeSha: TREE_SHA };

const FIXTURES_ROOT = fileURLToPath(
  new URL("fixtures/coding-issue-journey-evidence/", import.meta.url),
);
const TEMP_ROOTS = [];
const GIT = resolveHostExecutable("git");
const CONTRACTS = {
  codeTaskQualificationManifestFailures,
  codeTaskQualificationVerdictFor,
  validateCodeTaskQualificationFlowArtifact,
  validateCodeTaskQualificationManifest,
};
const TOOL_CATALOG = { OPENCODE_MODEL_VISIBLE_TOOLS: [{ name: "keiko_changeset_edit" }] };

it("keeps receipt comparison on canonical UTF-16 code-unit key order", () => {
  expect(canonicalJson({ b2: 2, b10: 10, a: 0, b1: 1 })).toBe('{"a":0,"b1":1,"b10":10,"b2":2}');
});

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name) {
  return {
    manifestPath: `${FIXTURES_ROOT}${name}/manifest.json`,
    receiptsDir: `${FIXTURES_ROOT}${name}/receipts`,
  };
}

const BASE_BINDING = {
  epicIssue: 3384,
  childIssue: 3390,
  registeredScenarioIds: ["issue-to-pr-full-access"],
};

async function runFixture(name, { headShas = HEAD_SHAS, binding = BASE_BINDING } = {}) {
  const staged = stageFiveFlowEvidence(name);
  return checkCodingIssueJourneyEvidence({ ...staged, binding, headShas });
}

const FLOW_MODES = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
  "supervised-coding",
  "autonomous-delivery",
];
const FLOW_ISSUES = [1, 3, 4, 5, 6];

function flowArtifact(
  index,
  cumulativeChargedNanoUsd,
  priorCumulative,
  sourceCommitSha = COMMIT_SHA,
) {
  const ordinal = index + 1;
  const flowId = `issue-to-pr-flow-0${String(ordinal)}`;
  const issueNumber = FLOW_ISSUES[index];
  const pullRequestNumber = 100 + ordinal;
  const pullRequestHeadSha = String(ordinal).repeat(40);
  return {
    evidenceKind: CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND,
    schemaVersion: 1,
    flowId,
    ordinal,
    repository: "oscharko/Wegwerf-Repo",
    issueReference: `https://github.com/oscharko/Wegwerf-Repo/issues/${String(issueNumber)}`,
    issueNumber,
    issueState: "closed",
    issueClosedAt: "2026-09-06T05:30:00.000Z",
    mode: FLOW_MODES[index],
    taskRunId: `run-${String(ordinal)}`,
    pullRequestReference: `https://github.com/oscharko/Wegwerf-Repo/pull/${String(pullRequestNumber)}`,
    pullRequestNumber,
    pullRequestHeadSha,
    pullRequestState: "merged",
    pullRequestMergedAt: "2026-09-06T05:29:00.000Z",
    mergeCommitSha: ["6", "7", "8", "9", "d"][index].repeat(40),
    requiredChecks: {
      observation: "observed",
      headSha: pullRequestHeadSha,
      requirementsVersion: "1",
      requirementsDigest: "e".repeat(64),
      evidenceRef: `ci-run-${String(ordinal)}`,
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
    },
    authorityObservation: {
      requestedMode: FLOW_MODES[index],
      effectiveMode: FLOW_MODES[index],
      approvalRequestCount: 1,
      toolInvocationCount: 2,
      effectStartedCount: 1,
      completedToolCount: 2,
      deniedToolCount: 0,
      failedToolCount: 0,
      otherToolCount: 0,
    },
    rubricReview: {
      reviewId: `review-${String(ordinal)}`,
      reviewDigest: "f".repeat(64),
      verdict: "approved",
      flowId,
      taskRunId: `run-${String(ordinal)}`,
      repository: "oscharko/Wegwerf-Repo",
      issueNumber,
      pullRequestNumber,
      pullRequestHeadSha,
      sourceCommitSha,
      rubricDigest: "e".repeat(64),
      criteriaTotal: 5,
      criteriaPassed: 5,
    },
    stageEvidence: {
      issueToPr: { scenarioId: `issue-to-pr-${FLOW_MODES[index]}`, receiptDigest: "1".repeat(64) },
      ciRepair:
        ordinal === 1 ? { scenarioId: "ci-repair-loop", receiptDigest: "2".repeat(64) } : null,
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
    sourceCommitSha,
    observedAt: "2026-09-06T05:31:00.000Z",
    spend: {
      budgetNanoUsd: 50_000_000_000,
      chargedDeltaNanoUsd: cumulativeChargedNanoUsd - priorCumulative,
      cumulativeChargedNanoUsd,
      remainingNanoUsd: 50_000_000_000 - cumulativeChargedNanoUsd,
    },
  };
}

function stageAssertions(flow, scenarioId) {
  if (scenarioId.startsWith("issue-to-pr-")) {
    return [
      `real-model-run-recorded:${flow.taskRunId}`,
      `draft-pull-request-created:${flow.repository}#${String(flow.pullRequestNumber)}`,
      `mode-selected:${flow.mode}`,
    ];
  }
  if (scenarioId === "ci-repair-loop") {
    return [
      "ci-terminal-state:technical-ready",
      "observed-failure-before-ready:true",
      "required-checks-total:1",
      "repair-head-changed:true",
      "ci-repair-evidence:observed-failure-repaired-fresh-head-ready",
    ];
  }
  if (scenarioId === "description-auto-draft-and-apply") {
    return [
      "auto-draft-reason:generated",
      "retained-proposal:proposal-1",
      "governed-apply-completed:true",
    ];
  }
  if (scenarioId === "mark-ready-intent") return ["ready-for-review-proposed:true"];
  return [
    "governed-merge-confirmed:true",
    "provider-merge-observed:true",
    "bound-issue-closure-observed:true",
  ];
}

function writeStageReceipt(receiptsDir, flow, scenarioId) {
  const receiptKey = `${flow.flowId}.${scenarioId}`;
  const receipt = {
    schemaVersion: 1,
    scenarioId,
    evidenceClass: "playwright-journey",
    sourceCommitSha: flow.sourceCommitSha,
    platformTarget: "macos-arm64",
    result: "passed",
    assertions: stageAssertions(flow, scenarioId),
    usage: {
      spendObservability: "unknown",
      observedToolCallEvents: 2,
      observedRunDurationMs: 10,
    },
    flowBinding: {
      flowId: flow.flowId,
      taskRunId: flow.taskRunId,
      repository: flow.repository,
      issueNumber: flow.issueNumber,
      pullRequestNumber: flow.pullRequestNumber,
      pullRequestHeadSha: flow.pullRequestHeadSha,
      ...(scenarioId === "human-merge-and-closure" ? { mergeCommitSha: flow.mergeCommitSha } : {}),
    },
  };
  writeQualificationEvidenceReceipt({
    receiptsDir,
    scenarioId,
    recordedAt: "2026-09-06T05:30:00Z",
    receipt,
  });
  return writeQualificationEvidenceReceipt({
    receiptsDir,
    scenarioId,
    receiptKey,
    recordedAt: "2026-09-06T05:30:00Z",
    receipt,
  });
}

function writeFlowStageReceipts(receiptsDir, flow, repairOrdinal = 1) {
  const modeScenarioId = `issue-to-pr-${flow.mode}`;
  const stage = (scenarioId) => ({
    scenarioId,
    receiptDigest: writeStageReceipt(receiptsDir, flow, scenarioId),
  });
  return {
    issueToPr: stage(modeScenarioId),
    ciRepair: flow.ordinal === repairOrdinal ? stage("ci-repair-loop") : null,
    description: stage("description-auto-draft-and-apply"),
    markReady: stage("mark-ready-intent"),
    governedMerge: stage("human-merge-and-closure"),
  };
}

function stageFiveFlowEvidence(fixtureName = "valid", repairOrdinal = 1) {
  const root = mkdtempSync(join(tmpdir(), "keiko-five-flow-evidence-"));
  TEMP_ROOTS.push(root);
  const sourceFixture = fixture(fixtureName);
  const receiptsDir = join(root, "receipts");
  if (existsSync(sourceFixture.receiptsDir)) {
    cpSync(sourceFixture.receiptsDir, receiptsDir, { recursive: true });
  } else {
    mkdirSync(receiptsDir, { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(sourceFixture.manifestPath, "utf8"));
  const cumulatives = [3_240_000, 5_000_000, 7_000_000, 9_000_000, 11_000_000];
  const baseArtifacts = cumulatives.map((cumulative, index) =>
    flowArtifact(
      index,
      cumulative,
      index === 0 ? 0 : cumulatives[index - 1],
      manifest.sourceCommitSha,
    ),
  );
  const artifacts = baseArtifacts.map((artifact) => ({
    ...artifact,
    stageEvidence: writeFlowStageReceipts(receiptsDir, artifact, repairOrdinal),
  }));
  for (const artifact of artifacts) {
    writeCodingIssueJourneyFlowEvidenceReceipt({
      receiptsDir,
      artifact,
      platform: "macos-arm64",
      recordedAt: "2026-09-06T05:30:00Z",
    });
  }
  const receipts = readFlowReceipts(
    receiptsDir,
    artifacts.map((artifact) => artifact.flowId),
  );
  const flows = artifacts.map((artifact) => {
    const receipt = receipts.get(artifact.flowId);
    if (receipt === undefined) throw new Error(`missing staged flow ${artifact.flowId}`);
    return {
      ...artifact,
      platform: receipt.platform,
      provenance: receipt.provenance,
      recordedAt: receipt.recordedAt,
      artifactDigest: receipt.artifactDigest,
      receiptDigest: receipt.receiptDigest,
    };
  });
  manifest.spendBudgetUsd = 50;
  manifest.observedSpendUsd = { outcome: "known", value: 0.011 };
  manifest.flows = flows;
  manifest.issueReference = { outcome: "known", value: flows[0].issueReference };
  manifest.pullRequestReference = { outcome: "known", value: flows[0].pullRequestReference };
  manifest.runReference = { outcome: "known", value: flows[0].taskRunId };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const descriptor = {
    flows: artifacts.map(({ flowId, ordinal, repository, issueNumber, mode }) => ({
      flowId,
      ordinal,
      repository,
      issueNumber,
      mode,
    })),
  };
  return { manifestPath, receiptsDir, descriptor, flows };
}

function git(root, ...args) {
  return execFileSync(GIT, args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}

function writePath(root, path, contents) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

function commit(root, message) {
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function replaceWithGitSymlink(root, path, target) {
  git(root, "config", "core.symlinks", "false");
  const oid = execFileSync(GIT, ["hash-object", "-w", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: target,
  }).trim();
  git(root, "update-index", "--add", "--cacheinfo", "120000", oid, path);
  git(root, "commit", "--quiet", "-m", "replace evidence with a git symlink");
  git(root, "reset", "--hard", "--quiet", "HEAD");
}

function stageCanonicalEvidenceOnlyLanding() {
  const staged = stageFiveFlowEvidence();
  const root = mkdtempSync(join(tmpdir(), "keiko-3390-checker-source-binding-"));
  TEMP_ROOTS.push(root);
  git(root, "init", "--quiet", "--initial-branch=dev");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Qualification Fixture");
  git(root, "config", "commit.gpgsign", "false");
  const descriptor = {
    scenarios: [
      { scenarioId: "issue-to-pr-full-access", evidenceClass: "playwright-journey" },
      ...[
        "issue-to-pr-governed-assist",
        "issue-to-pr-supervised-coding",
        "issue-to-pr-autonomous-delivery",
        "ci-repair-loop",
        "description-auto-draft-and-apply",
        "mark-ready-intent",
        "human-merge-and-closure",
      ].map((scenarioId) => ({ scenarioId, evidenceClass: "playwright-journey" })),
    ],
    flows: staged.descriptor.flows,
  };
  writePath(root, CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH, `${JSON.stringify(descriptor)}\n`);
  writePath(root, "packages/keiko-server/src/runtime.ts", "export const runtime = true;\n");
  writePath(root, "docs/release/1209-perf-evidence.json", "{}\n");
  writePath(root, "docs/release/1209-bundle-evidence.json", "{}\n");
  const sourceCommitSha = commit(root, "freeze qualification source");
  const sourceTreeSha = git(root, "rev-parse", `${sourceCommitSha}^{tree}`);
  const receiptsDir = join(root, CODING_ISSUE_JOURNEY_RECEIPTS_PATH);
  mkdirSync(receiptsDir, { recursive: true });
  cpSync(
    join(FIXTURES_ROOT, "valid/receipts/issue-to-pr-full-access.artifact"),
    join(receiptsDir, "issue-to-pr-full-access.artifact"),
  );
  writeFileSync(
    join(receiptsDir, "issue-to-pr-full-access.receipt.json"),
    `${JSON.stringify({ scenarioId: "issue-to-pr-full-access", commitSha: sourceCommitSha, platform: "macos-arm64", testStatus: "passed" })}\n`,
  );
  const cumulatives = [3_240_000, 5_000_000, 7_000_000, 9_000_000, 11_000_000];
  const baseArtifacts = cumulatives.map((value, index) =>
    flowArtifact(index, value, index === 0 ? 0 : cumulatives[index - 1], sourceCommitSha),
  );
  const artifacts = baseArtifacts.map((artifact) => ({
    ...artifact,
    stageEvidence: writeFlowStageReceipts(receiptsDir, artifact),
  }));
  for (const artifact of artifacts) {
    writeCodingIssueJourneyFlowEvidenceReceipt({
      receiptsDir,
      artifact,
      platform: "macos-arm64",
      recordedAt: "2026-09-06T05:30:00Z",
    });
  }
  const receiptMap = readFlowReceipts(
    receiptsDir,
    artifacts.map(({ flowId }) => flowId),
  );
  const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
  manifest.sourceCommitSha = sourceCommitSha;
  manifest.sourceTreeSha = sourceTreeSha;
  manifest.flows = artifacts.map((artifact) => {
    const receipt = receiptMap.get(artifact.flowId);
    if (receipt === undefined) throw new Error(`missing receipt for ${artifact.flowId}`);
    return {
      ...artifact,
      platform: receipt.platform,
      provenance: receipt.provenance,
      recordedAt: receipt.recordedAt,
      artifactDigest: receipt.artifactDigest,
      receiptDigest: receipt.receiptDigest,
    };
  });
  const manifestPath = join(root, CODING_ISSUE_JOURNEY_MANIFEST_PATH);
  writePath(root, CODING_ISSUE_JOURNEY_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  const landingCommitSha = commit(root, "land evidence only");
  return { root, manifestPath, receiptsDir, descriptor, sourceCommitSha, landingCommitSha };
}

describe("checkCodingIssueJourneyEvidence", () => {
  it("accepts real CI repair on a later completed flow and still requires its receipt", async () => {
    const staged = stageFiveFlowEvidence("valid", 2);
    const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
    const receipt = readReceipts(staged.receiptsDir).get("ci-repair-loop");
    manifest.scenarios.push({
      ...manifest.scenarios[0],
      scenarioId: "ci-repair-loop",
      artifactDigests: [receipt.digest],
      receiptDigest: { outcome: "known", value: receipt.digest },
    });
    writeFileSync(staged.manifestPath, JSON.stringify(manifest));
    const args = {
      ...staged,
      binding: {
        ...BASE_BINDING,
        registeredScenarioIds: [...BASE_BINDING.registeredScenarioIds, "ci-repair-loop"],
      },
      headShas: HEAD_SHAS,
    };
    expect(staged.flows[0].stageEvidence.ciRepair).toBeNull();
    expect(await checkCodingIssueJourneyEvidence(args)).toMatchObject({
      verdict: "qualified",
      failures: [],
    });
    rmSync(join(staged.receiptsDir, "ci-repair-loop.receipt.json"));
    expect((await checkCodingIssueJourneyEvidence(args)).failures).toContain(
      "ci-repair-loop: missing receipt",
    );
  });

  it("keeps five green-first deliveries unqualified without the required CI-repair scenario", async () => {
    const staged = stageFiveFlowEvidence("valid", null);
    const result = await checkCodingIssueJourneyEvidence({
      ...staged,
      binding: {
        ...BASE_BINDING,
        registeredScenarioIds: [...BASE_BINDING.registeredScenarioIds, "ci-repair-loop"],
      },
      headShas: HEAD_SHAS,
    });
    expect(result.verdict).toBe("blocked");
    expect(result.failures.some((failure) => failure.includes("ci-repair-loop"))).toBe(true);
  });

  it("rejects a stage receipt from another attempt even when its source and catalog are current", () => {
    const flow = flowArtifact(0, 3_240_000, 0);
    const scenario = {
      scenarioId: "issue-to-pr-governed-assist",
      outcome: "passed",
      receiptDigest: { outcome: "known", value: "c".repeat(64) },
    };
    const failures = evidenceGateFailures({
      manifestValidation: {
        ok: true,
        value: {
          sourceTreeSha: TREE_SHA,
          requiredTools: [],
          scenarios: [scenario],
          flows: [flow],
        },
      },
      manifestFailures: [],
      headCommitSha: COMMIT_SHA,
      headTreeSha: TREE_SHA,
      receiptsByScenarioId: new Map([
        [
          scenario.scenarioId,
          {
            commitSha: COMMIT_SHA,
            platform: undefined,
            testStatus: "passed",
            digest: "c".repeat(64),
            artifactValidationErrors: [],
            artifactIdentity: {
              scenarioId: scenario.scenarioId,
              sourceCommitSha: COMMIT_SHA,
              result: "passed",
              flowBinding: {
                flowId: flow.flowId,
                taskRunId: "run-from-failed-attempt",
                repository: flow.repository,
                issueNumber: flow.issueNumber,
                pullRequestNumber: flow.pullRequestNumber,
                pullRequestHeadSha: flow.pullRequestHeadSha,
              },
            },
          },
        ],
      ]),
      flowReceiptsById: new Map(),
      modelVisibleToolNames: new Set(),
    });

    expect(failures).toContain(
      "issue-to-pr-governed-assist: stage receipt does not match a completed flow",
    );
  });

  it("rejects a merge attestation whose merge identity differs from the completed flow", () => {
    const flow = flowArtifact(4, 11_000_000, 9_000_000);
    const scenario = {
      scenarioId: "human-merge-and-closure",
      outcome: "passed",
      receiptDigest: { outcome: "known", value: "c".repeat(64) },
    };
    const failures = evidenceGateFailures({
      manifestValidation: {
        ok: true,
        value: {
          sourceTreeSha: TREE_SHA,
          requiredTools: [],
          scenarios: [scenario],
          flows: [flow],
        },
      },
      manifestFailures: [],
      headCommitSha: COMMIT_SHA,
      headTreeSha: TREE_SHA,
      receiptsByScenarioId: new Map([
        [
          scenario.scenarioId,
          {
            commitSha: COMMIT_SHA,
            platform: undefined,
            testStatus: "passed",
            digest: "c".repeat(64),
            artifactValidationErrors: [],
            artifactIdentity: {
              scenarioId: scenario.scenarioId,
              sourceCommitSha: COMMIT_SHA,
              result: "passed",
              flowBinding: {
                flowId: flow.flowId,
                taskRunId: flow.taskRunId,
                repository: flow.repository,
                issueNumber: flow.issueNumber,
                pullRequestNumber: flow.pullRequestNumber,
                pullRequestHeadSha: flow.pullRequestHeadSha,
                mergeCommitSha: "f".repeat(40),
              },
            },
          },
        ],
      ]),
      flowReceiptsById: new Map(),
      modelVisibleToolNames: new Set(),
    });

    expect(failures).toContain(
      "human-merge-and-closure: attestation does not match the final completed flow",
    );
  });

  it("uses the production checker to accept only an evidence-only descendant of its source", async () => {
    const staged = stageCanonicalEvidenceOnlyLanding();
    const args = {
      root: staged.root,
      manifestPath: staged.manifestPath,
      receiptsDir: staged.receiptsDir,
      descriptorPath: join(staged.root, CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH),
      descriptor: staged.descriptor,
      binding: BASE_BINDING,
      contracts: CONTRACTS,
      toolCatalog: TOOL_CATALOG,
    };
    const accepted = await checkCodingIssueJourneyEvidence(args);
    expect(accepted).toMatchObject({
      verdict: "qualified",
      failures: [],
      sourceCommitSha: staged.sourceCommitSha,
      landingCommitSha: staged.landingCommitSha,
    });

    const receiptPath = join(staged.receiptsDir, "issue-to-pr-flow-01.receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, commitSha: staged.landingCommitSha })}\n`,
    );
    commit(staged.root, "misbind receipt");
    expect((await checkCodingIssueJourneyEvidence(args)).failures).toContain(
      "issue-to-pr-flow-01: stale or foreign flow source commit",
    );

    git(staged.root, "reset", "--hard", "--quiet", staged.landingCommitSha);
    writePath(
      staged.root,
      "packages/keiko-server/src/runtime.ts",
      "export const runtime = false;\n",
    );
    commit(staged.root, "change runtime after qualification");
    expect((await checkCodingIssueJourneyEvidence(args)).failures).toContain(
      "qualification source changed outside evidence outputs: packages/keiko-server/src/runtime.ts",
    );
  });

  it("rejects a clean Git-symlink artifact before parsing its external target", async () => {
    const staged = stageCanonicalEvidenceOnlyLanding();
    const artifactPath = `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/issue-to-pr-flow-01.artifact`;
    replaceWithGitSymlink(staged.root, artifactPath, "../../../../../../outside-artifact.json");

    expect(git(staged.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    const result = await checkCodingIssueJourneyEvidence({
      root: staged.root,
      manifestPath: staged.manifestPath,
      receiptsDir: staged.receiptsDir,
      descriptorPath: join(staged.root, CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH),
      binding: BASE_BINDING,
      contracts: CONTRACTS,
      toolCatalog: TOOL_CATALOG,
    });
    expect(result).toMatchObject({
      verdict: "blocked",
      failures: ["qualification evidence inputs must be tracked regular Git blobs"],
    });
  });

  it("derives production-functional authority only from matching trusted descriptor scenarios", () => {
    expect(
      qualificationBinding(BASE_BINDING, COMMIT_SHA, {
        flows: [],
        scenarios: [
          {
            scenarioId: "egress-confinement-macos-arm64",
            evidenceClass: "production-functional",
          },
          { scenarioId: "issue-to-pr-full-access", evidenceClass: "playwright-journey" },
        ],
        blocked: [
          {
            scenarioId: "egress-confinement-linux-windows",
            evidenceClass: "production-functional",
          },
        ],
      }).registeredProductionFunctionalScenarioIds,
    ).toEqual(["egress-confinement-macos-arm64"]);
  });

  it("passes a fully valid manifest bound to the qualified head with a matching receipt", async () => {
    const { verdict, failures } = await runFixture("valid");
    expect(failures).toEqual([]);
    expect(verdict).toBe("qualified");
  });

  it("cannot claim #3390 qualification without the five-flow descriptor", async () => {
    const { manifestPath, receiptsDir } = fixture("valid");
    const { verdict, failures } = await checkCodingIssueJourneyEvidence({
      manifestPath,
      receiptsDir,
      binding: BASE_BINDING,
      headShas: HEAD_SHAS,
    });
    expect(verdict).toBe("blocked");
    expect(failures).toContain("qualification descriptor must declare exactly five flows");
  });

  it("rejects a manifest bound to a stale/foreign commit SHA", async () => {
    const { verdict, failures } = await runFixture("stale-sha", {
      headShas: HEAD_SHAS,
      binding: BASE_BINDING,
    });
    expect(verdict).toBe("blocked");
    expect(failures.some((failure) => failure.includes("stale or foreign source SHA"))).toBe(true);
    // The stale fixture's own receipt is bound to STALE_COMMIT_SHA, so the receipt-binding check
    // independently reports it as foreign to the true head too (belt and braces).
    expect(failures.some((failure) => failure.includes(`expected ${COMMIT_SHA}`))).toBe(true);
  });

  it("rejects a passed scenario resting on scripted-model provenance", async () => {
    const { verdict, failures } = await runFixture("scripted-passed");
    expect(verdict).toBe("blocked");
    expect(
      failures.some((failure) =>
        failure.includes("scripted-model provenance cannot establish qualification"),
      ),
    ).toBe(true);
  });

  it("rejects a scenario whose evidenceClass is outside the shared registered vocabulary", async () => {
    const { verdict, failures } = await runFixture("missing-evidence-class");
    expect(verdict).toBe("blocked");
    expect(failures.some((failure) => failure.includes("not a registered evidence class"))).toBe(
      true,
    );
  });

  it("rejects a manifest that claims a receipt digest with no receipt on disk", async () => {
    const { verdict, failures } = await runFixture("missing-receipt");
    expect(verdict).toBe("blocked");
    expect(failures).toContain("issue-to-pr-full-access: missing receipt");
  });

  it("rejects a receipt whose artifact bytes do not hash to the manifest's claimed digest", async () => {
    const { verdict, failures } = await runFixture("wrong-digest");
    expect(verdict).toBe("blocked");
    expect(failures.some((failure) => failure.includes("wrong-SHA receipt"))).toBe(true);
  });

  it("rejects a receipt recorded on a different platform than the manifest claims", async () => {
    const { verdict, failures } = await runFixture("wrong-platform");
    expect(verdict).toBe("blocked");
    expect(
      failures.some((failure) => failure.includes("does not match the manifest's macos-arm64")),
    ).toBe(true);
  });

  it("rejects a skipped test receipt as insufficient release qualification evidence", async () => {
    const { verdict, failures } = await runFixture("skipped-test");
    expect(verdict).toBe("blocked");
    expect(
      failures.some((failure) => failure.includes("is not release qualification evidence")),
    ).toBe(true);
  });

  it("rejects a scenario that is not in the registered scenario set", async () => {
    const { verdict, failures } = await runFixture("unregistered-scenario", {
      headShas: HEAD_SHAS,
      binding: { ...BASE_BINDING, registeredScenarioIds: [] },
    });
    expect(verdict).toBe("blocked");
    expect(failures).toContain("manifest: unregistered scenario: issue-to-pr-full-access");
  });

  it("rejects a manifest that omits a scenario the binding requires (#3390 audit F3)", async () => {
    const { verdict, failures } = await runFixture("missing-scenario", {
      headShas: HEAD_SHAS,
      binding: {
        ...BASE_BINDING,
        registeredScenarioIds: ["issue-to-pr-full-access", "issue-to-pr-supervised-coding"],
      },
    });
    expect(verdict).toBe("blocked");
    expect(failures).toContain(
      "manifest: missing required scenario: issue-to-pr-supervised-coding",
    );
  });

  it("rejects a known journey outcome with no human merge attestation (#3390 audit F9)", async () => {
    const { verdict, failures } = await runFixture("missing-human-merge-attestation");
    expect(verdict).toBe("blocked");
    expect(failures).toContain(
      "manifest: humanMergeAttestationDigest required when journeyOutcomeDigest is known",
    );
  });

  it("rejects a requiredTools entry absent from the model-visible tool catalog (#3390 audit F10)", async () => {
    const { verdict, failures } = await runFixture("missing-required-tool");
    expect(verdict).toBe("blocked");
    expect(
      failures.includes(
        "requiredTools: keiko_shell_execute is not in the model-visible tool catalog",
      ),
    ).toBe(true);
  });

  it("accepts five distinct byte-bound completed flows and retains pre-flow failed spend", async () => {
    const staged = stageFiveFlowEvidence();
    const { verdict, failures } = await checkCodingIssueJourneyEvidence({
      manifestPath: staged.manifestPath,
      receiptsDir: staged.receiptsDir,
      binding: BASE_BINDING,
      descriptor: staged.descriptor,
      headShas: HEAD_SHAS,
    });
    expect(failures).toEqual([]);
    expect(verdict).toBe("qualified");
    expect(staged.flows[0].spend.chargedDeltaNanoUsd).toBe(3_240_000);
  });

  it("rejects tampered flow artifact bytes and unregistered receipt metadata", async () => {
    const staged = stageFiveFlowEvidence();
    const flowId = staged.flows[0].flowId;
    expect(() =>
      writeCodingIssueJourneyFlowEvidenceReceipt({
        receiptsDir: staged.receiptsDir,
        artifact: { ...flowArtifact(0, 3_240_000, 0), promptText: "must-not-write" },
        platform: "macos-arm64",
        recordedAt: "2026-09-06T05:30:00Z",
      }),
    ).toThrow("invalid qualification flow artifact");
    writeFileSync(join(staged.receiptsDir, `${flowId}.artifact`), "{}\n");
    const receiptPath = join(staged.receiptsDir, `${flowId}.receipt.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, promptText: "must-not-pass" })}\n`);
    const { failures } = await checkCodingIssueJourneyEvidence({
      manifestPath: staged.manifestPath,
      receiptsDir: staged.receiptsDir,
      binding: BASE_BINDING,
      descriptor: staged.descriptor,
      headShas: HEAD_SHAS,
    });
    expect(failures).toContain(`${flowId}: flow artifact digest mismatch`);
    expect(failures).toContain(`${flowId}: metadata has an unknown field`);
  });

  it("requires every flow's own stage receipt and rejects a prior-attempt binding", async () => {
    const staged = stageFiveFlowEvidence();
    const flow = staged.flows[1];
    const stageKey = `${flow.flowId}.description-auto-draft-and-apply`;
    const artifactPath = join(staged.receiptsDir, `${stageKey}.artifact`);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    writeFileSync(
      artifactPath,
      `${JSON.stringify({
        ...artifact,
        flowBinding: { ...artifact.flowBinding, taskRunId: "run-from-prior-attempt" },
      })}\n`,
    );

    const tampered = await checkCodingIssueJourneyEvidence({
      manifestPath: staged.manifestPath,
      receiptsDir: staged.receiptsDir,
      binding: BASE_BINDING,
      descriptor: staged.descriptor,
      headShas: HEAD_SHAS,
    });
    expect(tampered.failures).toContain(
      `${flow.flowId}: description-auto-draft-and-apply stage receipt digest mismatch`,
    );
    expect(tampered.failures).toContain(
      `${flow.flowId}: description-auto-draft-and-apply stage flow binding mismatch`,
    );

    rmSync(artifactPath);
    const missing = await checkCodingIssueJourneyEvidence({
      manifestPath: staged.manifestPath,
      receiptsDir: staged.receiptsDir,
      binding: BASE_BINDING,
      descriptor: staged.descriptor,
      headShas: HEAD_SHAS,
    });
    expect(missing.failures).toContain(
      `${flow.flowId}: missing description-auto-draft-and-apply stage receipt`,
    );
  });
});

describe("platformKeyFor", () => {
  it("maps every release-blocking desktop target plus the CI evidence host", () => {
    expect(platformKeyFor("darwin", "arm64")).toBe("macos-arm64");
    expect(platformKeyFor("darwin", "x64")).toBe("macos-x64");
    expect(platformKeyFor("win32", "x64")).toBe("windows-x64");
    expect(platformKeyFor("linux", "x64")).toBe("linux-x64");
  });

  it("returns undefined for an unsupported os/arch combination", () => {
    expect(platformKeyFor("linux", "arm64")).toBeUndefined();
    expect(platformKeyFor("sunos", "x64")).toBeUndefined();
  });
});

describe("deriveGateVerdict", () => {
  it("reports failed for a genuinely failed scenario even when the contract already blocked it", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "failed",
        failures: ["manifest: foreign epic issue binding"],
        manifestValidation: { ok: true, value: { scenarios: [] } },
      }),
    ).toBe("failed");
  });

  it("never upgrades a contract verdict when an evidence-gate failure exists", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "qualified",
        failures: ["issue-to-pr-full-access: missing receipt"],
        manifestValidation: { ok: true, value: { scenarios: [] } },
      }),
    ).toBe("blocked");
  });

  it("passes the contract verdict through when there are no evidence-gate failures", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "qualified",
        failures: [],
        manifestValidation: { ok: true, value: { scenarios: [] } },
      }),
    ).toBe("qualified");
  });

  it("is blocked when the manifest itself failed structural validation", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "blocked",
        failures: ["manifest: kind must be code-task-qualification-manifest"],
        manifestValidation: {
          ok: false,
          errors: ["kind must be code-task-qualification-manifest"],
        },
      }),
    ).toBe("blocked");
  });
});

describe("CLI entry point", () => {
  it("reports a FAIL line instead of an uncaught raw stack when the manifest is missing", () => {
    const result = spawnSync(
      process.execPath,
      [
        GATE_PATH,
        "--manifest",
        "/tmp/keiko-does-not-exist-manifest.json",
        "--receipts",
        "/tmp/keiko-does-not-exist-receipts",
        "--descriptor",
        join(process.cwd(), "docs/acceptance/coding-issue-journey-3390.json"),
        "--epic",
        "3384",
        "--child",
        "3390",
        "--registered",
        "issue-to-pr-full-access",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL");
    expect(result.stderr).toContain("keiko-does-not-exist-manifest.json");
    expect(result.stderr).not.toContain("node:fs");
    expect(result.stderr).not.toContain("at readFileSync");
  });
});
