// #3390 — one owner for the closed, body-free assertions emitted by both the independently
// selectable journey rows and the corresponding stages of each five-flow qualification drive.

import type { CodingWorkbenchMode, JourneyOutcome } from "@oscharko-dev/keiko-contracts";
import type { WorkbenchDescriptionStatus } from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";
import type { DeliveredPullRequest } from "./coding-issue-journey-live.js";
import {
  evaluateCiRepairLoopOutcome,
  type CiRepairOutcome,
} from "./coding-issue-journey-live-ci.js";
import type { RetainedDescriptionBinding } from "./coding-issue-journey-live-description.js";
import type { CodingIssueJourneyScenarioId } from "./coding-issue-journey-scenarios.js";

export function modeScenarioId(mode: CodingWorkbenchMode): CodingIssueJourneyScenarioId {
  const ids: Record<CodingWorkbenchMode, CodingIssueJourneyScenarioId> = {
    "governed-assist": "issue-to-pr-governed-assist",
    "supervised-coding": "issue-to-pr-supervised-coding",
    "autonomous-delivery": "issue-to-pr-autonomous-delivery",
  };
  return ids[mode];
}

export function issueToPrAssertions(
  delivered: DeliveredPullRequest,
  mode: CodingWorkbenchMode,
): readonly string[] {
  return [
    `real-model-run-recorded:${delivered.runId}`,
    `draft-pull-request-created:${delivered.repository}#${String(delivered.number)}`,
    `mode-selected:${mode}`,
  ];
}

export function ciRepairAssertions(outcome: CiRepairOutcome): readonly string[] {
  const evidence = evaluateCiRepairLoopOutcome(outcome);
  const repairHeadChanged = outcome.failureHeadSha !== outcome.finalHeadSha;
  if (evidence.result !== "passed") {
    throw new Error(
      `ci-repair-loop did not qualify (${evidence.result}: ${evidence.reason}) -- ` +
        `finalState=${outcome.finalState} observedFailureBeforeReady=${String(outcome.observedFailureBeforeReady)} ` +
        `repairHeadChanged=${String(repairHeadChanged)}`,
    );
  }
  return [
    `ci-terminal-state:${outcome.finalState}`,
    `observed-failure-before-ready:${String(outcome.observedFailureBeforeReady)}`,
    `required-checks-total:${String(outcome.requiredChecks.total)}`,
    `repair-head-changed:${String(repairHeadChanged)}`,
    `ci-repair-evidence:${evidence.reason}`,
  ];
}

export function descriptionAssertions(
  status: WorkbenchDescriptionStatus,
  retained: RetainedDescriptionBinding,
): readonly string[] {
  return [
    `auto-draft-reason:${status.reason}`,
    `retained-proposal:${retained.proposalId}`,
    "governed-apply-completed:true",
  ];
}

export function markReadyAssertions(): readonly string[] {
  return ["ready-for-review-proposed:true"];
}

export interface GovernedMergeAndClosureEvidence {
  readonly assertions: readonly string[];
  readonly mergeCommitSha: string;
}

export function governedMergeAndClosureEvidence(
  outcome: JourneyOutcome,
): GovernedMergeAndClosureEvidence {
  const remote = outcome.remote;
  if (remote === null) throw new Error("governed merge and closure evidence is incomplete");
  const { mergeCommitSha } = remote;
  if (typeof mergeCommitSha !== "string") {
    throw new Error("governed merge and closure evidence is incomplete");
  }
  const complete = [
    outcome.state === "completed",
    outcome.reason === "merge-and-closure-observed",
    remote.issue.state === "closed",
    typeof remote.mergedAt === "string",
    typeof remote.issue.closedAt === "string",
    remote.identity.repository === outcome.binding.repository,
    remote.identity.number === outcome.binding.prNumber,
    remote.issue.number === outcome.binding.issueNumber,
  ].every(Boolean);
  if (!complete) {
    throw new Error("governed merge and closure evidence is incomplete");
  }
  return {
    assertions: [
      "governed-merge-confirmed:true",
      "provider-merge-observed:true",
      "bound-issue-closure-observed:true",
    ],
    mergeCommitSha,
  };
}
