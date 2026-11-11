import {
  JIRA_GROUP_MUTATIONS,
  JIRA_ISSUE_ACTION_MUTATIONS,
  JIRA_MAINTENANCE_MUTATIONS,
  JIRA_DIRECTORY_ACCESS_MUTATIONS,
  JIRA_SCHEMA_MUTATIONS,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  jiraPresentationIdentity as id,
  jiraPresentationNativeText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const aliases = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.map((name) => name.replace(/[.-]/gu, "_")));
export const JIRA_GROUP_WRITE_TOOLS = aliases(JIRA_GROUP_MUTATIONS);
export const JIRA_ISSUE_ACTION_TOOLS = aliases(JIRA_ISSUE_ACTION_MUTATIONS);
export const JIRA_MAINTENANCE_WRITE_TOOLS = aliases(JIRA_MAINTENANCE_MUTATIONS);
export const JIRA_DIRECTORY_ACCESS_WRITE_TOOLS = aliases(JIRA_DIRECTORY_ACCESS_MUTATIONS);
export const JIRA_SCHEMA_WRITE_TOOLS = aliases(JIRA_SCHEMA_MUTATIONS);
export const JIRA_SYSTEM_ACTION_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_GROUP_WRITE_TOOLS,
  ...JIRA_ISSUE_ACTION_TOOLS,
  ...JIRA_MAINTENANCE_WRITE_TOOLS,
  ...JIRA_DIRECTORY_ACCESS_WRITE_TOOLS,
  ...JIRA_SCHEMA_WRITE_TOOLS,
]);
const RESULT_FIELDS = new Set([
  "outcome",
  "reason",
  "messages",
  "fieldErrors",
  "validation",
  "violations",
  "unchanged",
  "replayed",
  "guidance",
  "browseUrl",
  "operationBinding",
]);
function closed(source: Source, fields: readonly string[]): boolean {
  return Object.keys(source).every((key) => RESULT_FIELDS.has(key) || fields.includes(key));
}
export function jiraSystemList(
  value: unknown,
  item: (value: unknown) => boolean,
  minimum = 0,
  maximum = 1000,
  unique = true,
): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  return value.every(item) && (!unique || new Set(value).size === value.length);
}
const identifier = (value: unknown): boolean => id(value) !== undefined;
const principal = (value: unknown): boolean => text(value, 255, { multiline: true });
export function jiraSystemCustomField(value: unknown): boolean {
  return (
    typeof value === "string" && value.startsWith("customfield_") && identifier(value.slice(12))
  );
}
const digest = (value: unknown): boolean =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
function groupComplete(tool: string, source: Source): boolean {
  const common = ["userKey", "groupName", "groupPresent"];
  if (!principal(source.groupName) || source.groupPresent !== (tool !== "jira_delete_group"))
    return false;
  if (tool === "jira_create_group") return closed(source, common);
  if (tool === "jira_delete_group")
    return closed(source, [...common, "swapGroupName"]) && groupReplacement(source);
  return (
    closed(source, [...common, "targetUserKey", "requestedDirectMembership"]) &&
    principal(source.targetUserKey) &&
    source.requestedDirectMembership === (tool === "jira_add_group_user")
  );
}
function groupReplacement(source: Source): boolean {
  return (
    source.swapGroupName === undefined ||
    (principal(source.swapGroupName) && source.swapGroupName !== source.groupName)
  );
}
function issueComplete(tool: string, source: Source): boolean {
  if (!identifier(source.issueId) || !isSafeAtlassianIdentifier(source.issueKey)) return false;
  const common = ["userKey", "issueId", "issueKey"];
  if (tool === "jira_pin_comment")
    return (
      closed(source, [...common, "commentId", "commentPinned"]) &&
      identifier(source.commentId) &&
      source.commentPinned === true
    );
  return (
    closed(source, [...common, "notificationDigest", "recipientUserKeys"]) &&
    digest(source.notificationDigest) &&
    jiraSystemList(source.recipientUserKeys, principal, 1, 50)
  );
}
function node(value: unknown): boolean {
  return text(value, 255) && value !== "." && value !== ".." && !/[/\\%]/u.test(value);
}
const NODE_ACTIONS = new Set([
  "jira_request_cluster_index_snapshot",
  "jira_delete_cluster_node",
  "jira_mark_cluster_node_offline",
]);
function maintenanceComplete(tool: string, source: Source): boolean {
  if (NODE_ACTIONS.has(tool)) return closed(source, ["userKey", "nodeId"]) && node(source.nodeId);
  if (tool === "jira_reindex_issues")
    return (
      closed(source, ["userKey", "issueIds"]) && jiraSystemList(source.issueIds, identifier, 1, 50)
    );
  if (tool === "jira_process_reindex_requests")
    return (
      closed(source, ["userKey", "reindexRequestIds"]) &&
      (source.reindexRequestIds === undefined ||
        jiraSystemList(source.reindexRequestIds, identifier))
    );
  return closed(source, ["userKey"]);
}
function applicationRoles(tool: string, source: Source): boolean {
  const maximum = tool === "jira_set_application_roles" ? 1000 : 1;
  return jiraSystemList(source.applicationRoleKeys, isSafeAtlassianIdentifier, 1, maximum);
}
function directoryComplete(tool: string, source: Source): boolean {
  if (!principal(source.actorUserKey)) return false;
  if (tool === "jira_set_application_role" || tool === "jira_set_application_roles")
    return (
      closed(source, ["actorUserKey", "applicationRoleKeys"]) && applicationRoles(tool, source)
    );
  if (!principal(source.userKey) || !principal(source.username)) return false;
  return userTargetComplete(tool, source);
}
function userTargetComplete(tool: string, source: Source): boolean {
  const common = ["actorUserKey", "userKey", "username"];
  if (tool === "jira_set_user_columns")
    return (
      closed(source, [...common, "columnIds"]) &&
      jiraSystemList(source.columnIds, principal, 1, 1000, false)
    );
  if (tool === "jira_reset_user_columns")
    return (
      closed(source, [...common, "columnsResetRequested"]) && source.columnsResetRequested === true
    );
  return (
    closed(source, [...common, "applicationRoleKeys", "applicationAccessRequested"]) &&
    applicationRoles(tool, source) &&
    source.applicationAccessRequested === (tool === "jira_add_user_application")
  );
}
function typeComplete(tool: string, source: Source): boolean {
  if (
    !identifier(source.issueTypeId) ||
    source.issueTypePresent !== (tool !== "jira_delete_issue_type")
  )
    return false;
  const fields = ["userKey", "issueTypeId", "issueTypePresent"];
  if (tool !== "jira_delete_issue_type") return closed(source, fields);
  return (
    closed(source, [...fields, "replacementIssueTypeId"]) &&
    (source.replacementIssueTypeId === undefined ||
      (identifier(source.replacementIssueTypeId) &&
        source.replacementIssueTypeId !== source.issueTypeId))
  );
}
function linkComplete(tool: string, source: Source): boolean {
  if (tool === "jira_reset_link_type_order")
    return (
      closed(source, ["userKey", "linkTypeIds"]) && jiraSystemList(source.linkTypeIds, identifier)
    );
  if (tool === "jira_move_link_type")
    return (
      closed(source, ["userKey", "linkTypeId", "linkTypeIds"]) &&
      identifier(source.linkTypeId) &&
      jiraSystemList(source.linkTypeIds, identifier, 1) &&
      source.linkTypeIds.includes(String(source.linkTypeId))
    );
  return (
    closed(source, ["userKey", "linkTypeId", "linkTypePresent"]) &&
    identifier(source.linkTypeId) &&
    source.linkTypePresent === (tool !== "jira_delete_link_type")
  );
}
function fieldComplete(tool: string, source: Source): boolean {
  if (tool === "jira_create_custom_field")
    return (
      closed(source, ["userKey", "fieldId", "fieldPresent"]) &&
      jiraSystemCustomField(source.fieldId) &&
      source.fieldPresent === true
    );
  return (
    closed(source, ["userKey", "fieldIds", "fieldPresent"]) &&
    jiraSystemList(source.fieldIds, jiraSystemCustomField, 1, 50) &&
    source.fieldPresent === false
  );
}
function schemaComplete(tool: string, source: Source): boolean {
  if (tool === "jira_create_custom_field" || tool === "jira_delete_custom_fields")
    return fieldComplete(tool, source);
  if (tool === "jira_set_terminology")
    return (
      closed(source, ["userKey", "terminologyNames"]) &&
      jiraSystemList(source.terminologyNames, (name) => name === "epic" || name === "sprint", 1, 2)
    );
  return tool.includes("issue_type") ? typeComplete(tool, source) : linkComplete(tool, source);
}
function identityComplete(tool: string, source: Source): boolean {
  if (JIRA_DIRECTORY_ACCESS_WRITE_TOOLS.has(tool)) return directoryComplete(tool, source);
  if (!principal(source.userKey)) return false;
  if (JIRA_GROUP_WRITE_TOOLS.has(tool)) return groupComplete(tool, source);
  if (JIRA_ISSUE_ACTION_TOOLS.has(tool)) return issueComplete(tool, source);
  if (JIRA_MAINTENANCE_WRITE_TOOLS.has(tool)) return maintenanceComplete(tool, source);
  return JIRA_SCHEMA_WRITE_TOOLS.has(tool) && schemaComplete(tool, source);
}
export function jiraSystemActionIdentityComplete(tool: string, source: Source): boolean {
  if (!identityComplete(tool, source)) return false;
  const receipt = Object.fromEntries(
    Object.entries(source).filter(([key]) => !RESULT_FIELDS.has(key)),
  );
  return new TextEncoder().encode(JSON.stringify(receipt)).byteLength <= 16384;
}
const CONFIRMABLE = new Set([
  "jira_create_group",
  "jira_pin_comment",
  "jira_set_user_columns",
  "jira_update_issue_type",
  "jira_create_link_type",
  "jira_update_link_type",
  "jira_set_terminology",
]);
export function jiraSystemConfirmationUnavailable(tool: string): boolean {
  return JIRA_SYSTEM_ACTION_TOOLS.has(tool) && !CONFIRMABLE.has(tool);
}
const NOOP = new Set([
  "jira_remove_group_user",
  "jira_pin_comment",
  "jira_set_application_role",
  "jira_set_application_roles",
  "jira_set_user_columns",
  "jira_update_issue_type",
  "jira_update_link_type",
  "jira_set_terminology",
]);
export function jiraSystemNoopSupported(tool: string): boolean {
  return NOOP.has(tool);
}
