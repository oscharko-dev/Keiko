import { describe, expect, it } from "vitest";
import { JIRA_GROUP_MUTATIONS, JIRA_ISSUE_ACTION_MUTATIONS, JIRA_MAINTENANCE_MUTATIONS, JIRA_DIRECTORY_ACCESS_MUTATIONS, JIRA_SCHEMA_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraSystemActionIdentityComplete as complete, jiraSystemConfirmationUnavailable } from "./jira-system-action-receipt";
import { jiraSystemActionDetails as details } from "./jira-system-action-presentation";
import { jiraIssueTypeReviewDetails } from "./jira-schema-review-presentation";
import { jiraToolState, jiraMutationUnchanged } from "./jira-tool-presentation";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import { SYSTEM_ACTION_CASES, SYSTEM_REVIEWED_TYPE, systemActionCase, systemActionExchange } from "./jira-system-action.test-fixture";

describe("system action receipt and review presentation", () => {
  it("covers every canonical action with independent literal reviewed inputs and receipts", () => {
    expect(SYSTEM_ACTION_CASES.map(({ operation }) => operation).sort()).toEqual([
      ...JIRA_GROUP_MUTATIONS, ...JIRA_ISSUE_ACTION_MUTATIONS, ...JIRA_MAINTENANCE_MUTATIONS, ...JIRA_DIRECTORY_ACCESS_MUTATIONS, ...JIRA_SCHEMA_MUTATIONS,
    ].sort());
    expect(SYSTEM_ACTION_CASES.filter(({ confirmed }) => confirmed)).toHaveLength(7);
    expect(SYSTEM_ACTION_CASES.filter(({ confirmed }) => !confirmed)).toHaveLength(28);
  });
  it.each(SYSTEM_ACTION_CASES)("preserves $operation identity and refuses overstated stored success", (fixture) => {
    const tool = fixture.operation.replace(/[.-]/gu, "_");
    expect(complete(tool, fixture.receipt)).toBe(true);
    expect(jiraSystemConfirmationUnavailable(tool)).toBe(!fixture.confirmed);
    expect(jiraToolState(systemActionExchange(fixture), "completed")).toBe(fixture.confirmed ? "chat.jira.write.succeeded" : "chat.jira.write.unconfirmed");
    const missingActor = Object.fromEntries(Object.entries(fixture.receipt).filter(([key]) => key !== "actorUserKey" && key !== "userKey"));
    expect(jiraToolState(systemActionExchange(fixture, { ...missingActor, outcome: "succeeded" }), "completed")).toBe("chat.jira.write.unknown");
    const uncertain = systemActionExchange(fixture, { ...fixture.receipt, outcome: "succeeded" }, 0, "unknown");
    expect(jiraToolState(uncertain, "completed")).toBe("chat.jira.write.unknown");
    expect(jiraToolOutcomeView(uncertain).items.flatMap((item) => item.labels)).not.toContain("chat.jira.savedConfiguration.confirmed");
  });
  it.each([
    ["jira.create-custom-field", "fieldId"], ["jira.create-issue-type", "issueTypeId"], ["jira.create-link-type", "linkTypeId"],
  ] as const)("does not invent a missing acknowledgement identity for %s", (operation, field) => {
    const fixture = systemActionCase(operation);
    const partial = Object.fromEntries(Object.entries(fixture.receipt).filter(([key]) => key !== field));
    expect(jiraToolState(systemActionExchange(fixture, { ...partial, outcome: "succeeded" }), "completed")).toBe("chat.jira.write.unknown");
    expect(details(operation.replace(/[.-]/gu, "_"), partial)[0]?.labels).toContain("chat.jira.savedConfiguration.identityUnknown");
  });
  it.each([
    ["jira.delete-group", { groupPresent: true }], ["jira.delete-group", { swapGroupName: "R&D team" }],
    ["jira.add-group-user", { requestedDirectMembership: false }], ["jira.pin-comment", { commentPinned: false }],
    ["jira.notify-issue", { notificationDigest: "not-a-digest" }], ["jira.notify-issue", { recipientUserKeys: [] }],
    ["jira.delete-cluster-node", { nodeId: "../node" }], ["jira.reindex-issues", { issueIds: [] }],
    ["jira.set-application-role", { applicationRoleKeys: ["jira-software", "jira-core"] }],
    ["jira.remove-user-application", { applicationAccessRequested: true }], ["jira.reset-user-columns", { columnsResetRequested: false }],
    ["jira.delete-custom-fields", { fieldIds: ["summary"] }], ["jira.delete-custom-fields", { fieldIds: [] }],
    ["jira.delete-issue-type", { replacementIssueTypeId: "1" }], ["jira.move-link-type", { linkTypeId: "99" }],
    ["jira.reset-link-type-order", { linkTypeIds: ["7", "7"] }], ["jira.set-terminology", { terminologyNames: ["story"] }],
  ] as const)("refuses contradictory %s receipt context", (operation, changed) => {
    expect(complete(operation.replace(/[.-]/gu, "_"), { ...systemActionCase(operation).receipt, ...changed })).toBe(false);
  });
  it("keeps acknowledgement IDs absent rather than inferring a queue or a task from a zero count", () => {
    const known = details("jira_process_reindex_requests", { userKey: "actor-key", reindexRequestIds: [] })[0];
    expect(known?.facts).toContainEqual({ label: "chat.jira.systemAction.ackRequestCount", value: "0" });
    const unknown = details("jira_process_reindex_requests", { userKey: "actor-key" })[0];
    expect(unknown?.facts.some(({ label }) => label === "chat.jira.systemAction.ackRequestCount")).toBe(false);
    expect(unknown?.labels).toContain("chat.jira.systemAction.requestIdsUnknown");
    expect(unknown?.labels).toContain("chat.jira.systemAction.currentJobNotCorrelated");
  });
  it("keeps acting and target users separate and retains repeated column positions", () => {
    const fixture = systemActionCase("jira.set-user-columns");
    const facts = details("jira_set_user_columns", fixture.receipt)[0]?.facts;
    expect(facts).toContainEqual({ label: "chat.jira.systemAction.actorKey", value: "actor-key" });
    expect(facts).toContainEqual({ label: "chat.jira.systemAction.targetUser", value: "target-key" });
    expect(facts?.filter(({ label }) => label === "chat.jira.instanceWrite.columnPosition")).toEqual([
      { label: "chat.jira.instanceWrite.columnPosition", value: "1: status" },
      { label: "chat.jira.instanceWrite.columnPosition", value: "2: summary" },
      { label: "chat.jira.instanceWrite.columnPosition", value: "3: status" },
    ]);
    expect(complete("jira_set_user_columns", { ...fixture.receipt, actorUserKey: undefined })).toBe(false);
    expect(complete("jira_set_user_columns", { ...fixture.receipt, columnIds: [] })).toBe(false);
    expect(complete("jira_set_user_columns", { ...fixture.receipt, groupName: "foreign scope" })).toBe(false);
    expect(complete("jira_set_user_columns", { ...fixture.receipt, columnIds: Array.from({ length: 1000 }, () => "界".repeat(255)) })).toBe(false);
  });
  it.each(["jira.remove-group-user", "jira.set-application-role", "jira.update-issue-type"] as const)("honors only an explicit pre-effect no-op for %s", (operation) => {
    const fixture = systemActionCase(operation);
    const data = { ...fixture.receipt, outcome: "rejected", reason: "conflict", unchanged: true };
    expect(jiraMutationUnchanged(systemActionExchange(fixture, data))).toBe(true);
    expect(jiraMutationUnchanged(systemActionExchange(fixture, data, 0, "unknown"))).toBe(false);
    expect(jiraToolOutcomeView(systemActionExchange(fixture, data, 0, "unknown")).items.flatMap((item) => item.labels)).not.toContain("chat.jira.savedConfiguration.unchanged");
  });
  it.each(["jira.add-group-user", "jira.notify-issue", "jira.start-reindex", "jira.reset-user-columns"] as const)("does not invent a no-op for %s", (operation) => {
    const fixture = systemActionCase(operation);
    expect(jiraMutationUnchanged(systemActionExchange(fixture, { ...fixture.receipt, outcome: "rejected", reason: "conflict", unchanged: true }))).toBe(false);
  });
  it("shows target flags as requested when the persisted journal is uncertain", () => {
    const fixture = systemActionCase("jira.pin-comment");
    const view = jiraToolOutcomeView(systemActionExchange(fixture, { ...fixture.receipt, outcome: "succeeded" }, 0, "unknown"));
    expect(view.items.flatMap((item) => item.facts)).toContainEqual({ label: "chat.jira.systemAction.requestedPinned", value: "true" });
    expect(view.items.flatMap((item) => item.facts).some(({ label }) => label === "chat.jira.systemAction.observedPinned")).toBe(false);
  });
  it.each([null, "", "   "])("preserves observed issue-type description %j separately from unavailable review facts", (description) => {
    const reviewSnapshot = { ...SYSTEM_REVIEWED_TYPE, description };
    const detail = jiraIssueTypeReviewDetails({ ...SYSTEM_REVIEWED_TYPE, description, reviewSnapshot });
    expect(detail.labels).toContain("chat.jira.systemAction.reviewAvailable");
    expect(detail.facts).toContainEqual({ label: "chat.jira.systemAction.subtask", value: "false" });
    if (description === null) expect(detail.labels).toContain("chat.jira.structural.nativeNotProvided");
    if (description === "") expect(detail.labels).toContain("chat.jira.propertyMutation.emptyText");
  });
  it.each([
    undefined, { ...SYSTEM_REVIEWED_TYPE, description: undefined }, { ...SYSTEM_REVIEWED_TYPE, id: "2" },
    { ...SYSTEM_REVIEWED_TYPE, subtask: true }, { ...SYSTEM_REVIEWED_TYPE, description: 7 }, { ...SYSTEM_REVIEWED_TYPE, foreign: true },
  ])("refuses a missing or contradictory issue-type review snapshot", (reviewSnapshot) => {
    expect(jiraIssueTypeReviewDetails({ ...SYSTEM_REVIEWED_TYPE, reviewSnapshot }).labels).toContain("chat.jira.systemAction.reviewUnavailable");
  });
});
