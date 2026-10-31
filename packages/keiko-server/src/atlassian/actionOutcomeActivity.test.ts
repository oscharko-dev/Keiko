import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { expect, it } from "vitest";
import type {
  AtlassianConnectorActivityRecord,
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
it.each([...JIRA_MANAGED_READ_TOOLS, "assign-issue"] as const)(
  "reconstructs governed %s outcomes without content",
  (actionType) => {
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
    if (event === undefined) throw new Error("Missing activity event");
    const line = formatActivityLogProofLine(event);
    expect(expectActivityLogProof("atlassian.action.outcome.line", line)).toMatchObject({
      actionType,
      provider: "jira",
      outcome: "pending-review",
      failureReason: "none",
    });
    const analysis = analyzeLogText(line);
    expect(analysis.timelines).toHaveLength(1);
    expect(line).not.toContain("private-connector");
  },
);
