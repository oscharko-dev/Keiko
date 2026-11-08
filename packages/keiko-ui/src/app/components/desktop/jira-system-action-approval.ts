import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraDraftField } from "./jiraDraftTree";
import { jiraAdministrativeReviewedValue } from "./jira-administrative-mutation-approval";
import { jiraSystemActionContextLabels } from "./jira-system-action-presentation";
import { JIRA_SYSTEM_ACTION_TOOLS, JIRA_ISSUE_ACTION_TOOLS } from "./jira-system-action-receipt";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor", groupName: "chat.jira.accessWrite.groupName", swapGroupName: "chat.jira.systemAction.swapGroup",
  acceptGlobalPermissionChange: "chat.jira.systemAction.acceptAccess", confirmUnverifiedDeletion: "chat.jira.categoryWrite.acceptUnconfirmed",
  user: "chat.jira.systemAction.reviewedUser", users: "chat.jira.systemAction.explicitRecipients", expectedObservedMembership: "chat.jira.systemAction.observedInheritedMembership",
  issueId: "chat.jira.properties.issueId", issueKey: "chat.jira.fact.issueKeys", commentId: "chat.jira.fact.commentId", expectedBody: "chat.jira.systemAction.reviewedComment",
  expectedVisibility: "chat.jira.systemAction.reviewedVisibility", subject: "chat.jira.systemAction.subject", textBody: "chat.jira.systemAction.plainBody", confirmEmailSend: "chat.jira.systemAction.acceptNotification",
  expectedNode: "chat.jira.systemAction.reviewedNode", expectedClusterState: "chat.jira.systemAction.reviewedCluster", expectedRunning: "chat.jira.systemAction.reviewedRunning",
  expectedReindex: "chat.jira.systemAction.reviewedReindex", expectedUpgrade: "chat.jira.systemAction.reviewedUpgrade", expectedIssues: "chat.jira.systemAction.reviewedIssues",
  confirmUnverifiedEffect: "chat.jira.systemAction.acceptMaintenance", type: "chat.jira.systemAction.nativeKind", indexComments: "chat.jira.systemAction.indexComments",
  indexChangeHistory: "chat.jira.systemAction.indexHistory", indexWorklogs: "chat.jira.systemAction.indexWorklogs",
  role: "chat.jira.systemAction.roleReplacement", roles: "chat.jira.systemAction.roleReplacements", expectedApplicationRole: "chat.jira.systemAction.reviewedApplicationRole",
  expectedColumns: "chat.jira.instanceWrite.reviewedColumns", columns: "chat.jira.instanceWrite.requestedColumns",
  expectedIssueType: "chat.jira.systemAction.reviewedIssueType", expectedAlternative: "chat.jira.systemAction.reviewedAlternative",
  expectedFields: "chat.jira.systemAction.reviewedFields", expectedLinkType: "chat.jira.systemAction.reviewedLinkType", expectedLinkTypes: "chat.jira.systemAction.reviewedLinkOrder",
  expectedEntries: "chat.jira.systemAction.reviewedTerms", entries: "chat.jira.systemAction.requestedTerms", confirmUnverifiedMigration: "chat.jira.systemAction.acceptMigration",
  name: "chat.jira.structural.nativeName", description: "chat.jira.structural.nativeDescription", searcherKey: "chat.jira.systemAction.searcherKey",
  projectIds: "chat.jira.systemAction.explicitProjectIds", issueTypeIds: "chat.jira.schemeWrite.issueTypeOrder", inward: "chat.jira.systemAction.inward", outward: "chat.jira.systemAction.outward",
  direction: "chat.jira.systemAction.orderDirection", linkTypeId: "chat.jira.fact.linkTypeId", newPosition: "chat.jira.systemAction.newPosition",
};
const MEMBERS: Readonly<Record<string, WidgetMessageKey>> = { ...LABELS,
  key: "chat.jira.systemAction.nativePrincipalKey", id: "chat.jira.planning.nativeId", expected: "chat.jira.systemAction.reviewedRole", value: "chat.jira.instanceWrite.requestedValue",
  groups: "chat.jira.systemAction.applicationGroups", defaultGroups: "chat.jira.systemAction.defaultGroups", subtask: "chat.jira.systemAction.subtask", avatarId: "chat.jira.fact.avatarId", custom: "chat.jira.systemAction.customField",
  originalName: "chat.jira.systemAction.originalTerm", originalNamePlural: "chat.jira.systemAction.originalPlural", newName: "chat.jira.systemAction.newTerm", newNamePlural: "chat.jira.systemAction.newPlural", isDefault: "chat.jira.systemAction.defaultTerm",
  nodeId: "chat.jira.maintenance.nodeId", state: "chat.jira.systemAction.nativeState", alive: "chat.jira.systemAction.observedAlive", nodeBuildNumber: "chat.jira.systemAction.buildNumber", nodeVersion: "chat.jira.systemAction.version",
  lastStateChangeTimestamp: "chat.jira.systemAction.stateTimestamp", build: "chat.jira.systemAction.reviewedBuild", buildNumber: "chat.jira.systemAction.buildNumber", version: "chat.jira.systemAction.version",
  taskState: "chat.jira.systemAction.taskObservation", currentProgress: "chat.jira.systemAction.nativeProgress", success: "chat.jira.systemAction.nativeSuccess",
  currentSubTask: "chat.jira.systemAction.subTask", finishTime: "chat.jira.systemAction.finishTime", startTime: "chat.jira.systemAction.startTime", submittedTime: "chat.jira.systemAction.submittedTime",
  upgradeState: "chat.jira.systemAction.upgradeObservation", upgradeOutcome: "chat.jira.systemAction.upgradeOutcome", duration: "chat.jira.systemAction.duration", message: "chat.jira.systemAction.nativeMessage",
};
function selected(operation: string | undefined): string | undefined {
  const tool = operation?.replace(/[.-]/gu, "_"); return tool !== undefined && JIRA_SYSTEM_ACTION_TOOLS.has(tool) ? tool : undefined;
}
export function jiraSystemActionFacts(operation: string | undefined, key: string, value: unknown, t: OptionalWidgetTranslate): readonly JiraDraftField[] | undefined {
  const label = Object.hasOwn(LABELS, key) ? LABELS[key] : undefined;
  if (selected(operation) === undefined || label === undefined) return undefined;
  return [{ id: t(label), value: jiraAdministrativeReviewedValue(key, value, t, key.startsWith("expected"), MEMBERS) }];
}
export function jiraSystemActionContextFacts(operation: string | undefined, t: OptionalWidgetTranslate): readonly JiraDraftField[] {
  const tool = selected(operation); if (tool === undefined) return [];
  const labels: WidgetMessageKey[] = ["chat.jira.structural.noAtomicSnapshot", ...jiraSystemActionContextLabels(tool)];
  if (!JIRA_ISSUE_ACTION_TOOLS.has(tool)) labels.unshift("chat.jira.accessWrite.admin");
  return labels.map((label) => ({ id: t("chat.jira.savedConfiguration.nativeLimitation"), value: { kind: "text", text: t(label) } }));
}
