// Closed, body-free artifact contract for #3390 scenario receipts. The generic qualification
// writer is shared by unrelated platform qualification scripts, so this validator deliberately
// claims only the scenario ids whose artifact shapes it owns. Callers still bind the exact bytes
// through the existing receipt digest.

import { runtimeGatewayConfinementArtifactErrors } from "./runtime-gateway-confinement-evidence.mjs";
import { codingIssueJourneyPerformanceArtifactErrors } from "./coding-issue-journey-functional-evidence.mjs";
import { realBinaryScenarioArtifactErrors } from "./coding-issue-journey-real-binary-evidence.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REPOSITORY_PULL_REQUEST = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PLATFORM_TARGETS = new Set(["macos-arm64", "macos-x64", "windows-x64", "linux-x64"]);
const PLAYWRIGHT_SCENARIOS = new Set([
  "issue-to-pr-governed-assist",
  "issue-to-pr-supervised-coding",
  "issue-to-pr-autonomous-delivery",
  "ci-repair-loop",
  "description-auto-draft-and-apply",
  "mark-ready-intent",
  "human-merge-and-closure",
  "git-to-chat-connect-refine-apply",
  "git-chat-negative-effects",
]);
const FLOW_BOUND_STAGE_SCENARIOS = new Set([
  "issue-to-pr-governed-assist",
  "issue-to-pr-supervised-coding",
  "issue-to-pr-autonomous-delivery",
  "ci-repair-loop",
  "description-auto-draft-and-apply",
  "mark-ready-intent",
  "human-merge-and-closure",
]);

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasAssertion(assertions, prefix, value) {
  const matches = assertions.filter((assertion) => assertion.startsWith(`${prefix}:`));
  return matches.length === 1 && value(matches[0].slice(prefix.length + 1));
}

function exactAssertion(assertions, assertion) {
  return assertions.filter((candidate) => candidate === assertion).length === 1;
}

function modeAssertions(scenarioId, assertions) {
  const mode = scenarioId.slice("issue-to-pr-".length);
  return [
    assertions.length === 3,
    hasAssertion(assertions, "real-model-run-recorded", (value) => SAFE_TOKEN.test(value)),
    hasAssertion(assertions, "draft-pull-request-created", (value) =>
      REPOSITORY_PULL_REQUEST.test(value),
    ),
    exactAssertion(assertions, `mode-selected:${mode}`),
  ].every(Boolean);
}

function ciAssertions(assertions) {
  return [
    assertions.length === 5,
    exactAssertion(assertions, "ci-terminal-state:technical-ready"),
    exactAssertion(assertions, "observed-failure-before-ready:true"),
    hasAssertion(assertions, "required-checks-total", (value) => /^\d{1,9}$/u.test(value)),
    exactAssertion(assertions, "repair-head-changed:true"),
    exactAssertion(assertions, "ci-repair-evidence:observed-failure-repaired-fresh-head-ready"),
  ].every(Boolean);
}

function descriptionAssertions(assertions) {
  return [
    assertions.length === 3,
    hasAssertion(assertions, "auto-draft-reason", (value) => SAFE_TOKEN.test(value)),
    hasAssertion(assertions, "retained-proposal", (value) => SAFE_TOKEN.test(value)),
    exactAssertion(assertions, "governed-apply-completed:true"),
  ].every(Boolean);
}

function gitChatAssertions(assertions) {
  return [
    assertions.length === 2,
    exactAssertion(assertions, "malformed-effect-requests-rejected:9"),
    hasAssertion(assertions, "no-mutating-chat-controls-among", (value) =>
      /^\d{1,5}$/u.test(value),
    ),
  ].every(Boolean);
}

const ASSERTION_VALIDATORS = Object.freeze({
  "ci-repair-loop": ciAssertions,
  "description-auto-draft-and-apply": descriptionAssertions,
  "mark-ready-intent": (assertions) =>
    assertions.length === 1 && exactAssertion(assertions, "ready-for-review-proposed:true"),
  "human-merge-and-closure": (assertions) =>
    [
      assertions.length === 3,
      exactAssertion(assertions, "governed-merge-confirmed:true"),
      exactAssertion(assertions, "provider-merge-observed:true"),
      exactAssertion(assertions, "bound-issue-closure-observed:true"),
    ].every(Boolean),
  "git-to-chat-connect-refine-apply": (assertions) =>
    [
      assertions.length === 5,
      exactAssertion(assertions, "git-change-chat-connected:true"),
      exactAssertion(assertions, "refined-over-turns:2"),
      exactAssertion(assertions, "governed-apply-completed:true"),
      exactAssertion(assertions, "no-forbidden-session-requests:true"),
      exactAssertion(assertions, "no-forbidden-session-tool-events:true"),
    ].every(Boolean),
  "git-chat-negative-effects": gitChatAssertions,
});

function scenarioAssertionsAreValid(scenarioId, assertions) {
  if (scenarioId.startsWith("issue-to-pr-")) return modeAssertions(scenarioId, assertions);
  const validate = ASSERTION_VALIDATORS[scenarioId];
  return validate !== undefined && validate(assertions);
}

function identityErrors(value, scenarioId) {
  const checks = [
    [value.schemaVersion === 1, "schemaVersion must be 1"],
    [value.scenarioId === scenarioId, "scenarioId must match the receipt identity"],
    [value.evidenceClass === "playwright-journey", "evidenceClass must be playwright-journey"],
    [COMMIT_SHA.test(value.sourceCommitSha), "sourceCommitSha is invalid"],
    [PLATFORM_TARGETS.has(value.platformTarget), "platformTarget is invalid"],
    [value.result === "passed" || value.result === "failed", "result is invalid"],
  ];
  return checks.filter(([valid]) => !valid).map(([, error]) => error);
}

function assertionErrors(value, scenarioId) {
  if (
    !Array.isArray(value.assertions) ||
    !value.assertions.every((item) => typeof item === "string")
  ) {
    return ["assertions must be strings"];
  }
  if (value.result === "failed") {
    return value.assertions.length === 1 && value.assertions[0] === "scenario-execution-failed:true"
      ? []
      : ["failed scenarios must use the closed failure assertion"];
  }
  return scenarioAssertionsAreValid(scenarioId, value.assertions)
    ? []
    : ["passed scenario assertions do not match the scenario contract"];
}

function usageErrors(usage) {
  const valid = [
    exactKeys(usage, ["spendObservability", "observedToolCallEvents", "observedRunDurationMs"]),
    usage?.spendObservability === "unknown",
    Number.isSafeInteger(usage?.observedToolCallEvents),
    usage?.observedToolCallEvents >= 0,
    Number.isSafeInteger(usage?.observedRunDurationMs),
    usage?.observedRunDurationMs >= 0,
  ].every(Boolean);
  return valid ? [] : ["usage must have the closed body-free observed shape"];
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function flowBindingFieldsAreValid(binding, requiresMerge) {
  const values = [
    SAFE_TOKEN.test(binding?.flowId),
    SAFE_TOKEN.test(binding?.taskRunId),
    REPOSITORY.test(binding?.repository),
    positiveInteger(binding?.issueNumber),
    positiveInteger(binding?.pullRequestNumber),
    COMMIT_SHA.test(binding?.pullRequestHeadSha),
  ];
  if (requiresMerge) values.push(COMMIT_SHA.test(binding?.mergeCommitSha));
  return values.every(Boolean);
}

function flowBindingErrors(binding, requiresMerge) {
  const keys = [
    "flowId",
    "taskRunId",
    "repository",
    "issueNumber",
    "pullRequestNumber",
    "pullRequestHeadSha",
  ];
  if (requiresMerge) keys.push("mergeCommitSha");
  const valid = exactKeys(binding, keys) && flowBindingFieldsAreValid(binding, requiresMerge);
  return valid ? [] : ["flowBinding must have the closed completed-flow identity"];
}

function flowBoundScenario(scenarioId) {
  return FLOW_BOUND_STAGE_SCENARIOS.has(scenarioId);
}

function flowBoundArtifactErrors(value, scenarioId) {
  const binding = value.flowBinding;
  if (binding === undefined) {
    return scenarioId === "human-merge-and-closure"
      ? ["human-merge-and-closure requires a completed flow binding"]
      : [];
  }
  const errors = flowBindingErrors(binding, scenarioId === "human-merge-and-closure");
  if (value.result === "passed" && value.usage?.observedToolCallEvents <= 0) {
    errors.push("flow-bound stage must retain observed model tool activity");
  }
  if (!flowBoundScenario(scenarioId)) errors.push("scenario does not accept a flow binding");
  return errors;
}

function playwrightArtifactErrors(value, scenarioId) {
  const keys = [
    "schemaVersion",
    "scenarioId",
    "evidenceClass",
    "sourceCommitSha",
    "platformTarget",
    "result",
    "assertions",
    "usage",
  ];
  if (value?.flowBinding !== undefined) keys.push("flowBinding");
  if (!exactKeys(value, keys)) {
    return ["artifact must have the closed playwright-journey shape"];
  }
  const errors = [
    ...identityErrors(value, scenarioId),
    ...assertionErrors(value, scenarioId),
    ...usageErrors(value.usage),
  ];
  errors.push(...flowBoundArtifactErrors(value, scenarioId));
  return errors;
}

/** Returns null for receipt classes owned elsewhere; otherwise returns closed validation errors. */
export function codingIssueJourneyScenarioArtifactErrors(value, scenarioId) {
  if (PLAYWRIGHT_SCENARIOS.has(scenarioId)) return playwrightArtifactErrors(value, scenarioId);
  if (scenarioId === "egress-confinement-macos-arm64") {
    return runtimeGatewayConfinementArtifactErrors(value, scenarioId);
  }
  if (scenarioId === "coding-runtime-performance-budgets") {
    return codingIssueJourneyPerformanceArtifactErrors(value);
  }
  if (scenarioId === "real-binary-lane") return realBinaryScenarioArtifactErrors(value);
  return null;
}
