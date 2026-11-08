import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraPresentationFact as fact, jiraPresentationIdentity as id, jiraPresentationMutationLabels,
  jiraPresentationNativeText as text, type JiraPresentationSource as Source } from "./jira-presentation-values";
import { JIRA_SYSTEM_ACTION_TOOLS, JIRA_MAINTENANCE_WRITE_TOOLS, JIRA_DIRECTORY_ACCESS_WRITE_TOOLS,
  JIRA_GROUP_WRITE_TOOLS, JIRA_SCHEMA_WRITE_TOOLS, jiraSystemActionIdentityComplete,
  jiraSystemConfirmationUnavailable, jiraSystemNoopSupported, jiraSystemCustomField, jiraSystemList } from "./jira-system-action-receipt";

function outcome(tool: string, source: Source): WidgetMessageKey[] {
  if (!jiraSystemActionIdentityComplete(tool, source)) return ["chat.jira.savedConfiguration.identityUnknown"];
  if (source.outcome === "rejected" && jiraSystemNoopSupported(tool)) return jiraPresentationMutationLabels(source, true);
  if (jiraSystemConfirmationUnavailable(tool)) return ["chat.jira.savedConfiguration.unconfirmed"];
  return jiraPresentationMutationLabels(jiraSystemNoopSupported(tool) ? source : { ...source, unchanged: false }, true);
}
function achieved(tool: string, source: Source): boolean {
  return source.outcome === "succeeded" && !jiraSystemConfirmationUnavailable(tool) && jiraSystemActionIdentityComplete(tool, source);
}
function arrayFacts(value: unknown, label: WidgetMessageKey, count: WidgetMessageKey, valid: (value: unknown) => boolean, minimum = 0, maximum = 1000): JiraOutcomeFact[] {
  return jiraSystemList(value, valid, minimum, maximum) ? [{ label: count, value: String(value.length) }, ...value.flatMap((entry) => fact(label, entry))] : [];
}
const principal = (value: unknown): boolean => text(value, 255, { multiline: true });
const identifier = (value: unknown): boolean => id(value) !== undefined;
function actorFacts(tool: string, source: Source): JiraOutcomeFact[] {
  return JIRA_DIRECTORY_ACCESS_WRITE_TOOLS.has(tool)
    ? [...fact("chat.jira.systemAction.actorKey", source.actorUserKey), ...fact("chat.jira.systemAction.targetUser", source.userKey), ...fact("chat.jira.accounts.username", source.username)]
    : fact("chat.jira.systemAction.actorKey", source.userKey);
}
function targetFact(source: Source, field: string, label: WidgetMessageKey): JiraOutcomeFact[] {
  const value = source[field]; return typeof value === "boolean" ? [{ label, value: String(value) }] : [];
}
function groupFacts(source: Source): JiraOutcomeFact[] {
  return [...fact("chat.jira.accessWrite.groupName", source.groupName), ...fact("chat.jira.systemAction.swapGroup", source.swapGroupName),
    ...fact("chat.jira.systemAction.targetUser", source.targetUserKey), ...targetFact(source, "groupPresent", "chat.jira.systemAction.requestedPresence"),
    ...targetFact(source, "requestedDirectMembership", "chat.jira.systemAction.directMembershipTarget")];
}
function issueFacts(tool: string, source: Source): JiraOutcomeFact[] {
  return [...fact("chat.jira.properties.issueId", id(source.issueId)), ...fact("chat.jira.fact.issueKeys", source.issueKey), ...fact("chat.jira.fact.commentId", id(source.commentId)),
    ...targetFact(source, "commentPinned", achieved(tool, source) ? "chat.jira.systemAction.observedPinned" : "chat.jira.systemAction.requestedPinned"),
    ...fact("chat.jira.systemAction.notificationDigest", source.notificationDigest),
    ...arrayFacts(source.recipientUserKeys, "chat.jira.systemAction.recipientKey", "chat.jira.systemAction.requestedRecipientCount", principal, 1, 50)];
}
function maintenanceFacts(source: Source): JiraOutcomeFact[] {
  return [...fact("chat.jira.maintenance.nodeId", source.nodeId),
    ...arrayFacts(source.issueIds, "chat.jira.properties.issueId", "chat.jira.systemAction.requestedIssueCount", identifier, 1, 50),
    ...arrayFacts(source.reindexRequestIds, "chat.jira.systemAction.ackRequestId", "chat.jira.systemAction.ackRequestCount", identifier)];
}
function directoryFacts(source: Source): JiraOutcomeFact[] {
  const facts = [...arrayFacts(source.applicationRoleKeys, "chat.jira.systemAction.applicationRoleKey", "chat.jira.systemAction.selectedRoleCount", principal, 1),
    ...targetFact(source, "applicationAccessRequested", "chat.jira.systemAction.applicationTarget"), ...targetFact(source, "columnsResetRequested", "chat.jira.systemAction.resetTarget")];
  if (jiraSystemList(source.columnIds, principal, 1, 1000, false)) source.columnIds.forEach((column, index) => {
    facts.push({ label: "chat.jira.instanceWrite.columnPosition", value: `${String(index + 1)}: ${column}` });
  });
  return facts;
}
function schemaFacts(tool: string, source: Source): JiraOutcomeFact[] {
  const presence = achieved(tool, source) ? "chat.jira.systemAction.observedPresence" : "chat.jira.systemAction.requestedPresence";
  const fields = jiraSystemCustomField(source.fieldId) ? fact("chat.jira.configuration.fieldId", source.fieldId) : [];
  return [...fields, ...fact("chat.jira.fact.issueTypeId", id(source.issueTypeId)), ...fact("chat.jira.systemAction.replacementType", id(source.replacementIssueTypeId)),
    ...fact("chat.jira.fact.linkTypeId", id(source.linkTypeId)), ...targetFact(source, "fieldPresent", presence), ...targetFact(source, "issueTypePresent", presence), ...targetFact(source, "linkTypePresent", presence),
    ...arrayFacts(source.fieldIds, "chat.jira.configuration.fieldId", "chat.jira.systemAction.selectedFieldCount", jiraSystemCustomField, 1, 50),
    ...arrayFacts(source.linkTypeIds, "chat.jira.fact.linkTypeId", "chat.jira.systemAction.reviewedLinkTypeCount", identifier),
    ...arrayFacts(source.terminologyNames, "chat.jira.systemAction.originalTerm", "chat.jira.systemAction.selectedTermCount", (name) => name === "epic" || name === "sprint", 1, 2)];
}
function familyFacts(tool: string, source: Source): JiraOutcomeFact[] {
  if (JIRA_GROUP_WRITE_TOOLS.has(tool)) return groupFacts(source);
  if (JIRA_MAINTENANCE_WRITE_TOOLS.has(tool)) return maintenanceFacts(source);
  if (JIRA_DIRECTORY_ACCESS_WRITE_TOOLS.has(tool)) return directoryFacts(source);
  return JIRA_SCHEMA_WRITE_TOOLS.has(tool) ? schemaFacts(tool, source) : issueFacts(tool, source);
}
function directoryScope(tool: string): WidgetMessageKey {
  if (tool.includes("columns")) return "chat.jira.systemAction.namedUserLayout";
  return tool === "jira_set_application_role" || tool === "jira_set_application_roles"
    ? "chat.jira.systemAction.selectedRolesOnly" : "chat.jira.systemAction.applicationAssignment";
}
export function jiraSystemActionContextLabels(tool: string): readonly WidgetMessageKey[] {
  if (JIRA_MAINTENANCE_WRITE_TOOLS.has(tool)) return ["chat.jira.systemAction.maintenanceUnconfirmed", "chat.jira.systemAction.currentJobNotCorrelated"];
  if (JIRA_GROUP_WRITE_TOOLS.has(tool)) return ["chat.jira.systemAction.groupConsequences", "chat.jira.systemAction.inheritedMembership"];
  if (JIRA_DIRECTORY_ACCESS_WRITE_TOOLS.has(tool)) return ["chat.jira.access.configurationOnly", "chat.jira.systemAction.directoryConsequences",
    directoryScope(tool)];
  if (JIRA_SCHEMA_WRITE_TOOLS.has(tool)) return ["chat.jira.schemeWrite.configurationOnly", "chat.jira.systemAction.schemaConsequences",
    ...(tool.includes("link_type_order") || tool === "jira_move_link_type" ? ["chat.jira.systemAction.orderUnconfirmed"] as const : [])];
  return tool === "jira_notify_issue" ? ["chat.jira.systemAction.notificationUnconfirmed"] : ["chat.jira.systemAction.pinScope"];
}
export function jiraSystemActionDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  if (!JIRA_SYSTEM_ACTION_TOOLS.has(tool)) return [];
  const labels = [...outcome(tool, source), ...jiraSystemActionContextLabels(tool)];
  if (tool === "jira_process_reindex_requests" && source.reindexRequestIds === undefined) labels.push("chat.jira.systemAction.requestIdsUnknown");
  return [{ facts: [...actorFacts(tool, source), ...familyFacts(tool, source)], labels }];
}
