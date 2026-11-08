import { createHash } from "node:crypto";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { expect, it } from "vitest";
import type {
  AtlassianConnectorActivityRecord,
  AtlassianConnectorActionType,
  AtlassianConnectorActivityReasonCode,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { recordAtlassianActionOutcome } from "./actionOutcomeActivity.js";
import {
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  JIRA_MANAGED_READ_TOOLS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

function partial(
  reasonCode: AtlassianConnectorActivityReasonCode,
): AtlassianConnectorActivityRecord {
  return {
    schemaVersion: "1",
    activityId: "partial-activity",
    occurredAt: 0,
    connectorId: "private-connector",
    provider: "jira",
    actionType: "sync-project",
    actionClass: "connector-access",
    disposition: "allowed",
    outcome: "succeeded",
    reasonCode,
    correlationId: "partial-correlation",
    durationMs: 1,
    syncSummary: {
      schemaVersion: "1",
      outcome: "partial",
      counts: {
        addedItems: 1,
        changedItems: 0,
        removedItems: 0,
        unchangedItems: 0,
        failedItems: 0,
        deniedItems: 1,
      },
      fingerprintSetDigest: "0".repeat(64),
      completedAt: 1,
    },
  };
}
it.each([
  { reason: "scope-exceeded", expected: "other" },
  { reason: "mode-approval-required", expected: "none" },
  { reason: "malformed-payload", expected: "malformed-payload" },
  { reason: "effect-denied", expected: "effect-denied" },
  { reason: "cancelled", expected: "cancelled" },
] as const)("preserves partial-sync classification for $reason", ({ reason, expected }) => {
  const logs = createBufferedServerLogSink();
  recordAtlassianActionOutcome({ activityLog: logs }, partial(reason), "autonomous-delivery");
  expect(logs.events).toHaveLength(1);
  const event = logs.events[0];
  if (event === undefined) throw new Error("Missing activity event");
  const line = formatActivityLogProofLine(event);
  expect(expectActivityLogProof("atlassian.action.outcome.line", line)).toMatchObject({
    op: "atlassian.action.outcome",
    outcome: "partial",
    failureReason: expected,
    level: "warn",
  });
  expect(line).not.toContain("private-connector");
  expect(analyzeLogText(line).timelines).toHaveLength(1);
});
// These are the exact inputs whose terminal identity the dev proof already preserved.
const LEGACY_OUTCOME_ACTIONS = [
  "jira.projects",
  "jira.issue-types",
  "jira.create-fields",
  "jira.edit-fields",
  "jira.search",
  "jira.issue",
  "jira.comments",
  "jira.transitions",
  "jira.assignable-users",
  "jira.report",
  "jira.draft-stage",
  "jira.draft-batch",
  "assign-issue",
] as const;
const LEGACY_OUTCOME_INPUTS: ReadonlySet<string> = new Set(LEGACY_OUTCOME_ACTIONS);

function governedOutcome(
  actionType: AtlassianConnectorActionType,
): ReturnType<typeof expectActivityLogProof> {
  const logs = createBufferedServerLogSink();
  recordAtlassianActionOutcome(
    { activityLog: logs },
    {
      schemaVersion: "1",
      activityId: "synthetic-activity",
      occurredAt: 0,
      connectorId: "private-connector",
      provider: "jira",
      actionType,
      actionClass: ATLASSIAN_CONNECTOR_ACTION_CLASS[actionType],
      disposition: "review-required",
      outcome: "pending-review",
      reasonCode: "mode-approval-required",
      correlationId: "synthetic-correlation",
      durationMs: 1,
    },
    "governed-assist",
  );
  const event = logs.events[0];
  if (event === undefined) throw new TypeError("Missing activity event");
  const line = formatActivityLogProofLine(event);
  const proof = expectActivityLogProof("atlassian.action.outcome.line", line);
  expect(proof).toMatchObject({
    actionTypeDigest: createHash("sha256").update(actionType).digest("hex"),
    provider: "jira",
    outcome: "pending-review",
    failureReason: "none",
  });
  expect(analyzeLogText(line).timelines).toHaveLength(1);
  expect(line).not.toContain("private-connector");
  return proof;
}
it.each(LEGACY_OUTCOME_ACTIONS)(
  "reconstructs governed %s outcomes without content",
  (actionType) => {
    expect(governedOutcome(actionType)).toMatchObject({ actionType });
  },
);
it.each(JIRA_MANAGED_READ_TOOLS.filter((action) => !LEGACY_OUTCOME_INPUTS.has(action)))(
  "reconstructs new governed %s outcomes in the bounded read class without content",
  (actionType) => {
    expect(governedOutcome(actionType)).toMatchObject({ actionType: "jira-read" });
  },
);
