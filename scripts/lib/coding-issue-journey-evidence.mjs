// Pure cross-referencing logic for the #3390 qualification-manifest evidence gate. Kept free of
// node:fs and the keiko-contracts import (mirroring scripts/lib/code-task-acceptance.mjs's split
// between a pure projection/validator and its I/O-performing CLI wrapper) so it has direct vitest
// coverage without a package build. The CLI wrapper
// (scripts/check-coding-issue-journey-evidence.mjs) supplies the actual contract validators, the
// current git head commit/tree SHAs, and the receipts discovered on disk; this module only
// combines what it is handed.

import { compareStrings } from "./compare-strings.mjs";

const PLATFORM_KEY_BY_OS_ARCH = Object.freeze({
  "darwin:arm64": "macos-arm64",
  "darwin:x64": "macos-x64",
  "win32:x64": "windows-x64",
  "linux:x64": "linux-x64",
});
const FLOW_BOUND_STAGE_SCENARIOS = new Set([
  "issue-to-pr-governed-assist",
  "issue-to-pr-supervised-coding",
  "issue-to-pr-autonomous-delivery",
  "ci-repair-loop",
  "description-auto-draft-and-apply",
  "mark-ready-intent",
  "human-merge-and-closure",
]);

/**
 * Maps a Node `os.platform()`/`os.arch()` pair to a `CODE_TASK_EVIDENCE_PLATFORMS` member, or
 * `undefined` for a combination this repository has no evidence platform for.
 */
export function platformKeyFor(osName, archName) {
  return PLATFORM_KEY_BY_OS_ARCH[`${osName}:${archName}`];
}

function receiptBindingFailures(scenario, receipt, headCommitSha) {
  const failures = [];
  if (receipt.scenarioId !== scenario.scenarioId) {
    failures.push(`${scenario.scenarioId}: receipt metadata scenario identity mismatch`);
  }
  if (receipt.commitSha !== headCommitSha) {
    failures.push(
      `${scenario.scenarioId}: receipt is bound to a stale or foreign commit (expected ` +
        `${headCommitSha}, got ${String(receipt.commitSha)})`,
    );
  }
  if (receipt.platform !== scenario.platform) {
    failures.push(
      `${scenario.scenarioId}: receipt platform ${String(receipt.platform)} does not match the ` +
        `manifest's ${scenario.platform}`,
    );
  }
  if (receipt.digest !== scenario.receiptDigest.value) {
    failures.push(
      `${scenario.scenarioId}: receipt artifact digest does not match the manifest (wrong-SHA receipt)`,
    );
  }
  return failures;
}

function receiptTestStatusFailures(scenario, receipt) {
  if (receipt.testStatus === "skipped" || receipt.testStatus === "unreachable") {
    return [
      `${scenario.scenarioId}: receipt test status is ${String(receipt.testStatus)}, which is ` +
        "not release qualification evidence",
    ];
  }
  if (receipt.testStatus !== "passed" && scenario.outcome === "passed") {
    return [
      `${scenario.scenarioId}: receipt reports ${String(receipt.testStatus)} tests, which cannot ` +
        "support a passed outcome",
    ];
  }
  return [];
}

function scenarioReceiptFailures(scenario, receiptsByScenarioId, headCommitSha, flows) {
  if (scenario.receiptDigest.outcome !== "known") {
    return scenario.outcome === "passed"
      ? [`${scenario.scenarioId}: a passed scenario requires a known receipt digest`]
      : [];
  }
  const receipt = receiptsByScenarioId.get(scenario.scenarioId);
  if (receipt === undefined) {
    return [`${scenario.scenarioId}: missing receipt`];
  }
  const artifactFailures = (receipt.artifactValidationErrors ?? []).map(
    (error) => `${scenario.scenarioId}: ${error}`,
  );
  const artifactBindingFailures = scenarioArtifactBindingFailures(scenario, receipt, headCommitSha);
  artifactBindingFailures.push(...scenarioFlowBindingFailures(scenario, receipt, flows));
  return [
    ...artifactFailures,
    ...artifactBindingFailures,
    ...receiptBindingFailures(scenario, receipt, headCommitSha),
    ...receiptTestStatusFailures(scenario, receipt),
  ];
}

function flowMatchesBinding(flow, binding) {
  if (binding === undefined || binding === null) return false;
  return [
    [binding.flowId, flow.flowId],
    [binding.taskRunId, flow.taskRunId],
    [binding.repository, flow.repository],
    [binding.issueNumber, flow.issueNumber],
    [binding.pullRequestNumber, flow.pullRequestNumber],
    [binding.pullRequestHeadSha, flow.pullRequestHeadSha],
  ].every(([actual, expected]) => actual === expected);
}

function flowBoundScenario(scenarioId) {
  return FLOW_BOUND_STAGE_SCENARIOS.has(scenarioId);
}

function scenarioFlowBindingFailures(scenario, receipt, flows) {
  if (flows.length === 0 || !flowBoundScenario(scenario.scenarioId)) return [];
  const binding = receipt.artifactIdentity?.flowBinding;
  const flow = flows.find((candidate) => flowMatchesBinding(candidate, binding));
  if (flow === undefined) {
    return [`${scenario.scenarioId}: stage receipt does not match a completed flow`];
  }
  if (modeStageDoesNotMatch(scenario.scenarioId, flow.mode)) {
    return [`${scenario.scenarioId}: mode receipt does not match its completed flow`];
  }
  const finalFlow = flows.at(-1);
  if (mergeStageDoesNotMatch(scenario.scenarioId, flow, finalFlow, binding)) {
    return ["human-merge-and-closure: attestation does not match the final completed flow"];
  }
  return [];
}

function modeStageDoesNotMatch(scenarioId, mode) {
  return scenarioId.startsWith("issue-to-pr-") && scenarioId !== `issue-to-pr-${mode}`;
}

function mergeStageDoesNotMatch(scenarioId, flow, finalFlow, binding) {
  if (scenarioId !== "human-merge-and-closure") return false;
  return flow !== finalFlow || binding?.mergeCommitSha !== flow.mergeCommitSha;
}

function scenarioArtifactBindingFailures(scenario, receipt, headCommitSha) {
  if (receipt.artifactValidationErrors === null) return [];
  const identity = receipt.artifactIdentity;
  const checks = [
    [identity?.scenarioId === scenario.scenarioId, "artifact scenario identity mismatch"],
    [identity?.sourceCommitSha === headCommitSha, "artifact source commit is stale or foreign"],
    [identity?.platformTarget === scenario.platform, "artifact platform mismatch"],
    [
      (identity?.result === "passed") === (receipt.testStatus === "passed"),
      "artifact result disagrees with receipt test status",
    ],
  ];
  return checks.filter(([valid]) => !valid).map(([, error]) => `${scenario.scenarioId}: ${error}`);
}

function flowArtifactProjection(flow) {
  return {
    evidenceKind: flow.evidenceKind,
    schemaVersion: flow.schemaVersion,
    flowId: flow.flowId,
    ordinal: flow.ordinal,
    repository: flow.repository,
    issueReference: flow.issueReference,
    issueNumber: flow.issueNumber,
    issueState: flow.issueState,
    issueClosedAt: flow.issueClosedAt,
    mode: flow.mode,
    taskRunId: flow.taskRunId,
    pullRequestReference: flow.pullRequestReference,
    pullRequestNumber: flow.pullRequestNumber,
    pullRequestHeadSha: flow.pullRequestHeadSha,
    pullRequestState: flow.pullRequestState,
    pullRequestMergedAt: flow.pullRequestMergedAt,
    mergeCommitSha: flow.mergeCommitSha,
    requiredChecks: flow.requiredChecks,
    authorityObservation: flow.authorityObservation,
    rubricReview: flow.rubricReview,
    stageEvidence: flow.stageEvidence,
    transitions: flow.transitions,
    sourceCommitSha: flow.sourceCommitSha,
    observedAt: flow.observedAt,
    spend: flow.spend,
  };
}

function stageReceiptFailure(flow, stage, receiptsByScenarioId, headCommitSha) {
  const key = `${flow.flowId}.${stage.scenarioId}`;
  const receipt = receiptsByScenarioId.get(key);
  if (receipt === undefined) return [`${flow.flowId}: missing ${stage.scenarioId} stage receipt`];
  const identity = receipt.artifactIdentity;
  const prefix = `${flow.flowId}: ${stage.scenarioId} stage`;
  const failures = [
    [
      [receipt.scenarioId, identity?.scenarioId].every((id) => id === stage.scenarioId),
      `${prefix} scenario identity mismatch`,
    ],
    [receipt.digest === stage.receiptDigest, `${prefix} receipt digest mismatch`],
    [
      [receipt.commitSha, identity?.sourceCommitSha].every((sha) => sha === headCommitSha),
      `${prefix} source commit is stale or foreign`,
    ],
    [
      [
        receipt.platform === flow.platform,
        receipt.testStatus === "passed",
        receipt.provenance === "real-model",
      ].every(Boolean),
      `${prefix} is not passing real-model evidence`,
    ],
    [flowMatchesBinding(flow, identity?.flowBinding), `${prefix} flow binding mismatch`],
    [
      stage.scenarioId !== "human-merge-and-closure" ||
        identity?.flowBinding?.mergeCommitSha === flow.mergeCommitSha,
      `${flow.flowId}: governed merge stage merge commit mismatch`,
    ],
  ]
    .filter(([valid]) => !valid)
    .map(([, error]) => error);
  for (const error of receipt.artifactValidationErrors ?? []) {
    failures.push(`${flow.flowId}: ${stage.scenarioId} stage ${error}`);
  }
  return failures;
}

function flowStageReceiptFailures(flow, receiptsByScenarioId, headCommitSha) {
  const stageEvidence = flow.stageEvidence;
  if (stageEvidence === undefined || stageEvidence === null) {
    return [`${flow.flowId}: missing per-flow stage evidence`];
  }
  const stages = [
    stageEvidence.issueToPr,
    ...(stageEvidence.ciRepair === null ? [] : [stageEvidence.ciRepair]),
    stageEvidence.description,
    stageEvidence.markReady,
    stageEvidence.governedMerge,
  ];
  return stages.flatMap((stage) =>
    stageReceiptFailure(flow, stage, receiptsByScenarioId, headCommitSha),
  );
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function flowReceiptBindingFailures(flow, receipt, headCommitSha) {
  const failures = (receipt.metadataErrors ?? []).map((error) => `${flow.flowId}: ${error}`);
  if (receipt.flowId !== flow.flowId) failures.push(`${flow.flowId}: receipt flow id mismatch`);
  if (receipt.commitSha !== headCommitSha || flow.sourceCommitSha !== headCommitSha) {
    failures.push(`${flow.flowId}: stale or foreign flow source commit`);
  }
  if (receipt.platform !== flow.platform) failures.push(`${flow.flowId}: flow platform mismatch`);
  if (receipt.provenance !== "real-model" || receipt.testStatus !== "passed") {
    failures.push(`${flow.flowId}: flow receipt is not passing real-model evidence`);
  }
  if (receipt.artifactDigest !== flow.artifactDigest) {
    failures.push(`${flow.flowId}: flow artifact digest mismatch`);
  }
  if (receipt.receiptDigest !== flow.receiptDigest) {
    failures.push(`${flow.flowId}: flow receipt digest mismatch`);
  }
  return failures;
}

function flowReceiptFailures(flow, flowReceiptsById, headCommitSha) {
  const receipt = flowReceiptsById.get(flow.flowId);
  if (receipt === undefined) return [`${flow.flowId}: missing flow receipt`];
  const failures = [...flowReceiptBindingFailures(flow, receipt, headCommitSha)];
  if (!receipt.artifactValidation.ok) {
    failures.push(
      `${flow.flowId}: artifact failed structural validation ` +
        `(${String(receipt.artifactValidation.errors.length)} errors)`,
    );
  } else if (
    canonicalJson(receipt.artifactValidation.value) !== canonicalJson(flowArtifactProjection(flow))
  ) {
    failures.push(`${flow.flowId}: artifact facts do not match manifest flow`);
  }
  return failures;
}

/**
 * Flags a `requiredTools` entry the model-visible tool catalog on the head under qualification
 * does not project (#3390 audit F10 / issue #3390 contract-correction 4): the fixture rubric
 * would be unsolvable by the real model, and no scenario outcome can compensate for that.
 * `modelVisibleToolNames` is a `Set<string>` supplied by the caller so this module stays
 * dependency-free -- it never imports the built server package itself.
 */
function requiredToolFailures(requiredTools, modelVisibleToolNames) {
  return requiredTools
    .filter((tool) => !modelVisibleToolNames.has(tool))
    .map((tool) => `requiredTools: ${tool} is not in the model-visible tool catalog`);
}

/**
 * Cross-references a structurally validated qualification manifest against the qualified git
 * head and the receipts actually found on disk. Structural/binding failures already produced by
 * the contract layer (`codeTaskQualificationManifestFailures`) are passed in as `manifestFailures`
 * so this module stays dependency-free; a structurally invalid manifest short-circuits to its own
 * (prefixed) validation errors.
 */
export function evidenceGateFailures({
  manifestValidation,
  manifestFailures,
  headCommitSha,
  headTreeSha,
  receiptsByScenarioId,
  flowReceiptsById,
  modelVisibleToolNames,
}) {
  if (!manifestValidation.ok) {
    return manifestValidation.errors.map((error) => `manifest: ${error}`);
  }
  const manifest = manifestValidation.value;
  const failures = [];
  if (manifest.sourceTreeSha !== headTreeSha) {
    failures.push(
      `manifest is not bound to the qualified head: expected tree ${headTreeSha}, got ` +
        manifest.sourceTreeSha,
    );
  }
  for (const failure of manifestFailures) {
    failures.push(`manifest: ${failure}`);
  }
  failures.push(...requiredToolFailures(manifest.requiredTools, modelVisibleToolNames));
  for (const scenario of manifest.scenarios) {
    failures.push(
      ...scenarioReceiptFailures(scenario, receiptsByScenarioId, headCommitSha, manifest.flows),
    );
  }
  for (const flow of manifest.flows) {
    failures.push(
      ...flowReceiptFailures(flow, flowReceiptsById, headCommitSha),
      ...flowStageReceiptFailures(flow, receiptsByScenarioId, headCommitSha),
    );
  }
  return failures;
}

/**
 * The manifest-level gate verdict: a genuinely failed scenario is always "failed"; otherwise any
 * evidence-gate failure (a stale head, a missing/tampered/misbound receipt, an unreachable/skipped
 * test) downgrades the contract's own verdict to "blocked" and never upgrades one.
 */
export function deriveGateVerdict({ contractVerdict, failures, manifestValidation }) {
  if (!manifestValidation.ok) return "blocked";
  if (contractVerdict === "failed") return "failed";
  return failures.length === 0 ? contractVerdict : "blocked";
}
