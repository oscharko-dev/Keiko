import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraDraftField } from "./jiraDraftTree";
import { jiraAdministrativeReviewedValue } from "./jira-administrative-mutation-approval";
import { jiraSystemActionContextLabels } from "./jira-system-action-presentation";
import { JIRA_SYSTEM_ACTION_TOOLS, JIRA_ISSUE_ACTION_TOOLS } from "./jira-system-action-receipt";

const sys = <const Suffix extends string>(suffix: Suffix): `chat.jira.systemAction.${Suffix}` =>
  `chat.jira.systemAction.${suffix}`;
const LABEL_GROUP_1: Readonly<Record<string, WidgetMessageKey>> = {
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor",
  groupName: "chat.jira.accessWrite.groupName",
  swapGroupName: sys("swapGroup"),
  acceptGlobalPermissionChange: sys("acceptAccess"),
  confirmUnverifiedDeletion: "chat.jira.categoryWrite.acceptUnconfirmed",
  user: sys("reviewedUser"),
  users: sys("explicitRecipients"),
  expectedObservedMembership: sys("observedInheritedMembership"),
  issueId: "chat.jira.properties.issueId",
};
const LABEL_GROUP_2: Readonly<Record<string, WidgetMessageKey>> = {
  issueKey: "chat.jira.fact.issueKeys",
  commentId: "chat.jira.fact.commentId",
  expectedBody: sys("reviewedComment"),
  expectedVisibility: sys("reviewedVisibility"),
  subject: sys("subject"),
  textBody: sys("plainBody"),
  confirmEmailSend: sys("acceptNotification"),
  expectedNode: sys("reviewedNode"),
  expectedClusterState: sys("reviewedCluster"),
  expectedRunning: sys("reviewedRunning"),
  expectedReindex: sys("reviewedReindex"),
  expectedUpgrade: sys("reviewedUpgrade"),
  expectedIssues: sys("reviewedIssues"),
};
const LABEL_GROUP_3: Readonly<Record<string, WidgetMessageKey>> = {
  confirmUnverifiedEffect: sys("acceptMaintenance"),
  type: sys("nativeKind"),
  indexComments: sys("indexComments"),
  indexChangeHistory: sys("indexHistory"),
  indexWorklogs: sys("indexWorklogs"),
  role: sys("roleReplacement"),
  roles: sys("roleReplacements"),
};
const LABEL_GROUP_4: Readonly<Record<string, WidgetMessageKey>> = {
  expectedApplicationRole: sys("reviewedApplicationRole"),
  expectedColumns: "chat.jira.instanceWrite.reviewedColumns",
  columns: "chat.jira.instanceWrite.requestedColumns",
  expectedIssueType: sys("reviewedIssueType"),
  expectedAlternative: sys("reviewedAlternative"),
  expectedFields: sys("reviewedFields"),
  expectedLinkType: sys("reviewedLinkType"),
  expectedLinkTypes: sys("reviewedLinkOrder"),
  expectedEntries: sys("reviewedTerms"),
  entries: sys("requestedTerms"),
  confirmUnverifiedMigration: sys("acceptMigration"),
};
const LABEL_GROUP_5: Readonly<Record<string, WidgetMessageKey>> = {
  name: "chat.jira.structural.nativeName",
  description: "chat.jira.structural.nativeDescription",
  searcherKey: sys("searcherKey"),
  projectIds: sys("explicitProjectIds"),
  issueTypeIds: "chat.jira.schemeWrite.issueTypeOrder",
  inward: sys("inward"),
  outward: sys("outward"),
  direction: sys("orderDirection"),
  linkTypeId: "chat.jira.fact.linkTypeId",
  newPosition: sys("newPosition"),
};
const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  ...LABEL_GROUP_1,
  ...LABEL_GROUP_2,
  ...LABEL_GROUP_3,
  ...LABEL_GROUP_4,
  ...LABEL_GROUP_5,
};
const MEMBER_GROUP_1: Readonly<Record<string, WidgetMessageKey>> = {
  key: sys("nativePrincipalKey"),
  id: "chat.jira.planning.nativeId",
  expected: sys("reviewedRole"),
  value: "chat.jira.instanceWrite.requestedValue",
  groups: sys("applicationGroups"),
  defaultGroups: sys("defaultGroups"),
  subtask: sys("subtask"),
  avatarId: "chat.jira.fact.avatarId",
  custom: sys("customField"),
  originalName: sys("originalTerm"),
  originalNamePlural: sys("originalPlural"),
  newName: sys("newTerm"),
};
const MEMBER_GROUP_2: Readonly<Record<string, WidgetMessageKey>> = {
  newNamePlural: sys("newPlural"),
  isDefault: sys("defaultTerm"),
  nodeId: "chat.jira.maintenance.nodeId",
  state: sys("nativeState"),
  alive: sys("observedAlive"),
  nodeBuildNumber: sys("buildNumber"),
  nodeVersion: sys("version"),
  lastStateChangeTimestamp: sys("stateTimestamp"),
};
const MEMBER_GROUP_3: Readonly<Record<string, WidgetMessageKey>> = {
  build: sys("reviewedBuild"),
  buildNumber: sys("buildNumber"),
  version: sys("version"),
  taskState: sys("taskObservation"),
  currentProgress: sys("nativeProgress"),
  success: sys("nativeSuccess"),
  currentSubTask: sys("subTask"),
  finishTime: sys("finishTime"),
  startTime: sys("startTime"),
  submittedTime: sys("submittedTime"),
  upgradeState: sys("upgradeObservation"),
  upgradeOutcome: sys("upgradeOutcome"),
  duration: sys("duration"),
  message: sys("nativeMessage"),
};
const MEMBERS: Readonly<Record<string, WidgetMessageKey>> = {
  ...LABELS,
  ...MEMBER_GROUP_1,
  ...MEMBER_GROUP_2,
  ...MEMBER_GROUP_3,
};
function selected(operation: string | undefined): string | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  return tool !== undefined && JIRA_SYSTEM_ACTION_TOOLS.has(tool) ? tool : undefined;
}
export function jiraSystemActionFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  const label = Object.hasOwn(LABELS, key) ? LABELS[key] : undefined;
  if (selected(operation) === undefined || label === undefined) return undefined;
  return [
    {
      id: t(label),
      value: jiraAdministrativeReviewedValue(key, value, t, key.startsWith("expected"), MEMBERS),
    },
  ];
}
export function jiraSystemActionContextFacts(
  operation: string | undefined,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] {
  const tool = selected(operation);
  if (tool === undefined) return [];
  const labels: WidgetMessageKey[] = [
    "chat.jira.structural.noAtomicSnapshot",
    ...jiraSystemActionContextLabels(tool),
  ];
  if (!JIRA_ISSUE_ACTION_TOOLS.has(tool)) labels.unshift("chat.jira.accessWrite.admin");
  return labels.map((label) => ({
    id: t("chat.jira.savedConfiguration.nativeLimitation"),
    value: { kind: "text", text: t(label) },
  }));
}
