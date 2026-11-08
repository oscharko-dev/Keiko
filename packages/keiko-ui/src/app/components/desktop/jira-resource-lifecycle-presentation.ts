import { JIRA_ISSUE_LIFECYCLE_MUTATIONS, JIRA_PROJECT_LIFECYCLE_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraPresentationFact as fact, jiraPresentationMutationLabels } from "./jira-presentation-values";
import { accountResourceAliases, accountResourceFields as fields, accountResourceId as id, accountResourceKey as key,
  accountResourcePrincipal as principal, accountResourceInteger as integer, accountResourceList as list,
  accountResourceDigest as digest, accountResourceBudget as budget, accountResourceOwn as own, type AccountResourceSource as Source } from "./jira-account-resource-values";

export const JIRA_RESOURCE_LIFECYCLE_TOOLS = accountResourceAliases([...JIRA_ISSUE_LIFECYCLE_MUTATIONS, ...JIRA_PROJECT_LIFECYCLE_MUTATIONS,
  "jira.create-issues", "jira.create-reciprocal-remote-link"]);
const ISSUE = ["userKey", "issueId", "issueKey"];
const PROJECT = ["userKey", "projectId", "projectKey"];
function issueContext(source: Source): boolean { return principal(source.userKey) && id(source.issueId) && key(source.issueKey); }
function projectContext(source: Source): boolean { return principal(source.userKey) && id(source.projectId) && key(source.projectKey); }
function paired(source: Source, a: string, b: string, max: number, first: (value: unknown) => boolean, second: (value: unknown) => boolean, uniqueSecond = true): boolean {
  const left = source[a]; const right = source[b];
  return list(left, first, 1, max) && list(right, second, 1, max, uniqueSecond) && left.length === right.length;
}
function optionalPaired(source: Source, a: string, b: string, max: number, first: (value: unknown) => boolean, second: (value: unknown) => boolean, uniqueSecond = true): boolean {
  if (!Object.hasOwn(source, a) && !Object.hasOwn(source, b)) return true;
  return paired(source, a, b, max, first, second, uniqueSecond);
}
function bulk(source: Source): boolean {
  if (!fields(source, ["userKey", "requestedIssueCount"], ["issueIds", "issueKeys", "bulkFailedElementNumbers", "bulkFailureStatuses"]) ||
    !principal(source.userKey) || !integer(source.requestedIssueCount, 1, 50)) return false;
  const identities = optionalPaired(source, "issueIds", "issueKeys", source.requestedIssueCount, id, key);
  const errors = optionalPaired(source, "bulkFailedElementNumbers", "bulkFailureStatuses", source.requestedIssueCount, integer, (value) => integer(value, 400, 599), false);
  return identities && errors;
}
function reciprocal(source: Source): boolean {
  return fields(source, [...ISSUE, "applicationLinkId", "applicationLinkDestinationDigest", "selectedRemoteIssueId", "delegatedEffectRequested"], ["linkId"]) &&
    issueContext(source) && typeof source.applicationLinkId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(source.applicationLinkId) &&
    digest(source.applicationLinkDestinationDigest) && id(source.selectedRemoteIssueId) && source.delegatedEffectRequested === true &&
    (!Object.hasOwn(source, "linkId") || id(source.linkId));
}
function archivedIssues(source: Source): boolean {
  return fields(source, ["userKey", "issueIds", "issueKeys", "issueArchivedRequested"]) && principal(source.userKey) &&
    paired(source, "issueIds", "issueKeys", 50, id, key) && source.issueArchivedRequested === true;
}
function movedSubtask(source: Source): boolean {
  return fields(source, [...ISSUE, "subtaskIds", "originalPosition", "currentPosition"]) && list(source.subtaskIds, id, 2) &&
    integer(source.originalPosition) && integer(source.currentPosition) && source.originalPosition !== source.currentPosition;
}
function issueComplete(tool: string, source: Source): boolean {
  if (tool === "jira_create_issues") return bulk(source);
  if (tool === "jira_create_reciprocal_remote_link") return reciprocal(source);
  if (tool === "jira_archive_issues") return archivedIssues(source);
  if (!issueContext(source)) return false;
  if (tool === "jira_move_subtask") return movedSubtask(source);
  return tool === "jira_delete_issue" ? fields(source, [...ISSUE, "issuePresent"]) && source.issuePresent === false
    : fields(source, [...ISSUE, "issueArchivedRequested"]) && source.issueArchivedRequested === (tool === "jira_archive_issue");
}
function projectAssociation(tool: string, source: Source): boolean {
  const remove = tool === "jira_remove_project_priority_scheme";
  return fields(source, [...PROJECT, "schemeId", "projectSchemeAssigned", ...(remove ? [] : ["previousSchemeId"])]) && id(source.schemeId) &&
    source.projectSchemeAssigned === !remove && (remove || id(source.previousSchemeId));
}
function projectComplete(tool: string, source: Source): boolean {
  if (!projectContext(source)) return false;
  if (tool === "jira_delete_project") return fields(source, [...PROJECT, "projectPresent"]) && source.projectPresent === false;
  if (tool === "jira_archive_project" || tool === "jira_restore_project") return fields(source, [...PROJECT, "projectArchivedRequested"]) && source.projectArchivedRequested === (tool === "jira_archive_project");
  if (tool === "jira_update_project_type") return fields(source, [...PROJECT, "projectTypeKey"]) && key(source.projectTypeKey);
  return projectAssociation(tool, source);
}
export function jiraResourceLifecycleIdentityComplete(tool: string, source: Source): boolean {
  if (!JIRA_RESOURCE_LIFECYCLE_TOOLS.has(tool) || !own(source)) return false;
  const valid = tool.includes("project") ? projectComplete(tool, source) : issueComplete(tool, source);
  return valid && budget(source);
}
const NOOP = new Set(["jira_archive_project", "jira_restore_project", "jira_update_project_type", "jira_set_project_permission_scheme", "jira_set_project_priority_scheme"]);
export function jiraResourceLifecycleNoopSupported(tool: string): boolean { return NOOP.has(tool); }
function sequence(source: Source, name: string, label: WidgetMessageKey): JiraOutcomeFact[] {
  const values = source[name];
  return Array.isArray(values) ? values.map((value, index) => ({ label, value: `${String(index + 1)}: ${String(value)}` })) : [];
}
function targetFacts(source: Source): JiraOutcomeFact[] {
  const labels = { issuePresent: "chat.jira.resourceWrite.requestedPresence", projectPresent: "chat.jira.resourceWrite.requestedPresence",
    issueArchivedRequested: "chat.jira.resourceWrite.requestedArchive", projectArchivedRequested: "chat.jira.resourceWrite.requestedArchive",
    projectSchemeAssigned: "chat.jira.resourceWrite.requestedAssociation" } as const;
  return Object.entries(labels).flatMap(([field, label]) => typeof source[field] === "boolean" ? [{ label, value: String(source[field]) }] : []);
}
function scope(tool: string): WidgetMessageKey {
  if (tool === "jira_create_issues") return "chat.jira.resourceWrite.bulkScope";
  if (tool === "jira_create_reciprocal_remote_link") return "chat.jira.resourceWrite.delegationScope";
  if (tool === "jira_move_subtask") return "chat.jira.resourceWrite.subtaskScope";
  return tool.includes("project") ? "chat.jira.resourceWrite.projectScope" : "chat.jira.resourceWrite.issueScope";
}
export function jiraResourceLifecycleDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  const valid = jiraResourceLifecycleIdentityComplete(tool, source);
  const labels: WidgetMessageKey[] = [scope(tool), ...(valid ? jiraPresentationMutationLabels({ ...source, outcome: source.outcome === "succeeded" ? "succeeded-unconfirmed" : source.outcome,
    unchanged: jiraResourceLifecycleNoopSupported(tool) && source.unchanged === true }, true) : ["chat.jira.savedConfiguration.identityUnknown"] as const)];
  if (!valid) return [{ facts: [], labels }];
  const facts = [...fact("chat.jira.systemAction.actorKey", source.userKey), ...fact("chat.jira.properties.issueId", source.issueId),
    ...fact("chat.jira.fact.issueKeys", source.issueKey), ...fact("chat.jira.fact.projectKey", source.projectKey), ...fact("chat.jira.fact.projectId", source.projectId),
    ...fact("chat.jira.fact.projectType", source.projectTypeKey), ...fact("chat.jira.access.schemeId", source.schemeId), ...fact("chat.jira.resourceWrite.previousScheme", source.previousSchemeId),
    ...targetFacts(source), ...sequence(source, "issueIds", "chat.jira.resourceWrite.nativeIssueId"), ...sequence(source, "issueKeys", "chat.jira.fact.issueKeys"),
    ...sequence(source, "subtaskIds", "chat.jira.resourceWrite.reviewedSubtask"), ...sequence(source, "bulkFailedElementNumbers", "chat.jira.resourceWrite.failedElement"),
    ...sequence(source, "bulkFailureStatuses", "chat.jira.resourceWrite.failureStatus"),
    ...fact("chat.jira.resourceWrite.applicationLink", source.applicationLinkId), ...fact("chat.jira.resourceWrite.destinationDigest", source.applicationLinkDestinationDigest),
    ...fact("chat.jira.resourceWrite.selectedRemoteIssue", source.selectedRemoteIssueId), ...fact("chat.jira.fact.linkId", source.linkId)];
  for (const [field, label] of [["requestedIssueCount", "chat.jira.resourceWrite.requestedCount"], ["originalPosition", "chat.jira.resourceWrite.originalPosition"], ["currentPosition", "chat.jira.resourceWrite.currentPosition"]] as const)
    if (integer(source[field])) facts.push({ label, value: String(source[field]) });
  if (tool === "jira_create_issues" && source.issueIds === undefined) labels.push("chat.jira.resourceWrite.createdUnknown");
  return [{ facts, labels }];
}
