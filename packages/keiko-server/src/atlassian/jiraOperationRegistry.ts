import {
  JIRA_MANAGED_ACTION_TYPES,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
  type ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";

export type JiraOperationTool = JiraManagedReadToolName | JiraMutationOperation;
type CompositeTool = "jira.report" | "jira.draft-stage" | "jira.draft";
type NativeTool = Exclude<JiraOperationTool, CompositeTool>;
type JiraOperationEffect = "remote-read" | "remote-write" | "local-report" | "local-draft";
type JiraPermissionPolicy =
  | "observed-column-layout"
  | "observed-maintenance-status"
  | "admin-workflow-configuration"
  | "visible-custom-field-configuration"
  | "observed-terminology"
  | "visible-jql-metadata"
  | "board-issue-estimation"
  | "scoped-user-candidates"
  | "visible-directory-suggestions"
  | "visible-role-configuration"
  | "visible-priority-configuration"
  | "observed-instance-metadata"
  | "permission-definitions"
  | "current-actor-metadata"
  | "visible-issue-metadata"
  | "visible-permission-configuration"
  | "visible-security-configuration"
  | "visible-notification-configuration"
  | "visible-users"
  | "visible-groups"
  | "admin-application-roles"
  | "visible-projects"
  | "admin-workflow-schemes"
  | "admin-issue-type-schemes"
  | "visible-screen-configuration"
  | "current-project-metadata"
  | "native-project-key-validation"
  | "explicit-project-permissions"
  | "accessible-project-type"
  | "project-create-and-readback"
  | "project-update-and-readback"
  | "visible-boards"
  | "visible-sprints"
  | "visible-epics"
  | "visible-filters"
  | "board-create-and-readback"
  | "sprint-create-and-readback"
  | "sprint-update-and-readback"
  | "issue-membership-and-readback"
  | "epic-update-and-readback"
  | "visible-components"
  | "attachment-availability"
  | "visible-attachments"
  | "visible-avatars"
  | "visible-dashboards"
  | "visible-filter-permissions"
  | "authenticated-user-preferences"
  | "visible-comments"
  | "visible-link-types"
  | "visible-issue-links"
  | "visible-worklogs"
  | "visible-watchers"
  | "visible-voters"
  | "current-user-watch-and-readback"
  | "current-user-vote-and-readback"
  | "worklog-create-and-readback"
  | "worklog-update-and-readback"
  | "comment-update-and-readback"
  | "comment-delete-and-absence"
  | "attachment-delete-and-absence"
  | "worklog-delete-and-absence"
  | "visible-versions"
  | "component-create-and-readback"
  | "component-update-and-readback"
  | "version-create-and-readback"
  | "version-update-and-readback"
  | "current-create-metadata"
  | "current-edit-metadata"
  | "visible-issues"
  | "current-transitions"
  | "current-assignable-users"
  | "comment-create-and-readback"
  | "attachment-create-and-readback"
  | "composed-current-metadata";

interface OperationDefinitionBase {
  readonly tool: JiraOperationTool;
  readonly deployment: "data-center";
  readonly identity: string;
  readonly effects: readonly JiraOperationEffect[];
  /** Existing Keiko policy owner; the registry never grants permissions. */
  readonly authorityAction: (typeof JIRA_MANAGED_ACTION_TYPES)[JiraOperationTool];
  /** Existing handler metadata plus Jira's response remain the permission decision. */
  readonly permissionPolicy: JiraPermissionPolicy;
}
export type JiraOperationDefinition = OperationDefinitionBase &
  (
    | {
        readonly kind: "native";
        readonly method: "GET" | "POST" | "PUT" | "DELETE";
        readonly apiRoot: "/rest/api/2" | "/rest/agile/1.0";
        readonly pathTemplate: string;
        /** Create/edit may add the already-approved bounded issue links through their owner. */
        readonly continuationPolicy: "none" | "approved-issue-links";
      }
    | { readonly kind: "composite"; readonly members: readonly JiraOperationTool[] }
  );
export interface JiraOperationBinding extends CatalogJsonObject {
  readonly identity: string;
  readonly contractDigest: string;
}
export interface JiraOperationContract {
  readonly definition: JiraOperationDefinition;
  readonly declaration: ManagedMcpToolDeclaration;
  readonly binding: JiraOperationBinding;
}

type JiraApiRoot = "/rest/api/2" | "/rest/agile/1.0";
type NativeSpecification = readonly [
  "GET" | "POST" | "PUT" | "DELETE",
  "read" | "write",
  string,
  JiraPermissionPolicy,
  JiraApiRoot?,
];
type NativeGroup<K extends NativeTool> = Readonly<Record<K, NativeSpecification>>;
function reads<const K extends NativeTool>(
  permissionPolicy: JiraPermissionPolicy,
  paths: Readonly<Record<K, string>>,
  root: JiraApiRoot = "/rest/api/2",
): NativeGroup<K> {
  const result: Partial<Record<K, NativeSpecification>> = {};
  for (const tool in paths) {
    if (Object.hasOwn(paths, tool))
      result[tool] = ["GET", "read", paths[tool], permissionPolicy, root];
  }
  return result as NativeGroup<K>;
}
function writes<const K extends NativeTool>(
  permissionPolicy: JiraPermissionPolicy,
  paths: Readonly<Record<K, readonly ["POST" | "PUT" | "DELETE", string]>>,
  root: JiraApiRoot = "/rest/api/2",
): NativeGroup<K> {
  const result: Partial<Record<K, NativeSpecification>> = {};
  for (const tool in paths) {
    if (!Object.hasOwn(paths, tool)) continue;
    const [method, path] = paths[tool];
    result[tool] = [method, "write", path, permissionPolicy, root];
  }
  return result as NativeGroup<K>;
}
const NATIVE: Readonly<Record<NativeTool, NativeSpecification>> = {
  ...reads("observed-column-layout", {
    "jira.system-columns": "/settings/columns",
    "jira.user-columns": "/user/columns",
    "jira.filter-columns": "/filter/{id}/columns",
  }),
  ...reads("observed-maintenance-status", {
    "jira.reindex-status": "/reindex",
    "jira.reindex-progress": "/reindex/progress",
    "jira.reindex-request": "/reindex/request/{requestId}",
    "jira.reindex-requests": "/reindex/request/bulk",
    "jira.upgrade-result": "/upgrade",
    "jira.index-snapshots": "/index-snapshot",
    "jira.app-monitoring": "/monitoring/app",
    "jira.ipd-monitoring": "/monitoring/ipd",
    "jira.jmx-metrics": "/monitoring/jmx/getAvailableMetrics",
    "jira.cluster-nodes": "/cluster/nodes",
    "jira.cluster-upgrade-state": "/cluster/zdu/state",
    "jira.index-snapshot-status": "/index-snapshot/isRunning",
    "jira.index-summary": "/index/summary",
  }),
  ...reads("admin-workflow-configuration", { "jira.workflows": "/workflow" }),
  ...reads("visible-custom-field-configuration", {
    "jira.custom-fields": "/customFields",
    "jira.custom-field-options": "/customFields/{customFieldId}/options",
  }),
  ...reads("observed-terminology", {
    "jira.terminology": "/terminology/entries",
    "jira.terminology-entry": "/terminology/entries/{originalName}",
  }),
  ...reads("visible-jql-metadata", {
    "jira.jql-autocomplete": "/jql/autocompletedata",
    "jira.jql-suggestions": "/jql/autocompletedata/suggestions",
  }),
  ...reads("scoped-user-candidates", {
    "jira.multi-project-assignable-users": "/user/assignable/multiProjectSearch",
    "jira.permission-users": "/user/permission/search",
    "jira.browse-permission-users": "/user/viewissue/search",
  }),
  ...reads("visible-directory-suggestions", {
    "jira.group-user-picker": "/groupuserpicker",
  }),
  ...reads("visible-role-configuration", {
    "jira.roles": "/role",
    "jira.role": "/role/{id}",
    "jira.role-default-actors": "/role/{id}/actors",
    "jira.project-roles": "/project/{projectIdOrKey}/role",
    "jira.project-role": "/project/{projectIdOrKey}/role/{id}",
  }),
  ...reads("visible-priority-configuration", {
    "jira.priority-schemes": "/priorityschemes",
    "jira.priority-scheme": "/priorityschemes/{schemeId}",
  }),
  ...reads("observed-instance-metadata", {
    "jira.jmx-metrics-exposed": "/monitoring/jmx/areMetricsExposed",
    "jira.search-max-aggregation-buckets": "/searchLimits/maxAggregationBuckets",
    "jira.search-max-result-window": "/searchLimits/maxResultWindow",
    "jira.read-only-mode": "/readonly-mode",
    "jira.server-info": "/serverInfo",
    "jira.instance-configuration": "/configuration",
  }),
  ...reads("permission-definitions", { "jira.permission-definitions": "/permissions" }),
  ...reads("current-actor-metadata", { "jira.myself": "/myself" }),
  ...reads("visible-issue-metadata", {
    "jira.issue-type-property-keys": "/issuetype/{issueTypeId}/properties",
    "jira.issue-type-property": "/issuetype/{issueTypeId}/properties/{propertyKey}",
    "jira.fields": "/field",
    "jira.custom-field-option": "/customFieldOption/{id}",
    "jira.global-issue-types": "/issuetype",
    "jira.issue-type": "/issuetype/{id}",
    "jira.issue-type-page": "/issuetype/page",
    "jira.issue-type-alternatives": "/issuetype/{id}/alternatives",
    "jira.priorities": "/priority",
    "jira.priority": "/priority/{id}",
    "jira.priority-page": "/priority/page",
    "jira.resolutions": "/resolution",
    "jira.resolution": "/resolution/{id}",
    "jira.resolution-page": "/resolution/page",
    "jira.statuses": "/status",
    "jira.status": "/status/{idOrName}",
    "jira.status-page": "/status/page",
    "jira.status-categories": "/statuscategory",
    "jira.status-category": "/statuscategory/{idOrKey}",
  }),
  ...reads("visible-permission-configuration", {
    "jira.project-permission-scheme": "/project/{projectKeyOrId}/permissionscheme",
    "jira.permission-schemes": "/permissionscheme",
    "jira.permission-scheme": "/permissionscheme/{schemeId}",
    "jira.permission-grants": "/permissionscheme/{schemeId}/permission",
    "jira.permission-grant": "/permissionscheme/{schemeId}/permission/{permissionId}",
  }),
  ...reads("visible-security-configuration", {
    "jira.project-issue-security-scheme": "/project/{projectKeyOrId}/issuesecuritylevelscheme",
    "jira.project-security-levels": "/project/{projectKeyOrId}/securitylevel",
    "jira.issue-security-schemes": "/issuesecurityschemes",
    "jira.issue-security-scheme": "/issuesecurityschemes/{id}",
    "jira.security-level": "/securitylevel/{id}",
  }),
  ...reads("visible-notification-configuration", {
    "jira.notification-schemes": "/notificationscheme",
    "jira.notification-scheme": "/notificationscheme/{id}",
    "jira.project-notification-scheme": "/project/{projectKeyOrId}/notificationscheme",
  }),
  ...reads("visible-users", {
    "jira.user-property-keys": "/user/properties",
    "jira.user-property": "/user/properties/{propertyKey}",
    "jira.user": "/user",
    "jira.users": "/user/search",
    "jira.user-directory": "/user/list",
    "jira.user-picker": "/user/picker",
  }),
  ...reads("visible-groups", {
    "jira.group-members": "/group/member",
    "jira.groups": "/groups/picker",
  }),
  ...reads("admin-application-roles", {
    "jira.application-roles": "/applicationrole",
    "jira.application-role": "/applicationrole/{key}",
  }),
  ...reads("admin-issue-type-schemes", {
    "jira.issue-type-schemes": "/issuetypescheme",
    "jira.issue-type-scheme": "/issuetypescheme/{schemeId}",
    "jira.issue-type-scheme-projects": "/issuetypescheme/{schemeId}/associations",
  }),
  ...reads("admin-workflow-schemes", {
    "jira.workflow-scheme": "/workflowscheme/{id}",
    "jira.workflow-scheme-default": "/workflowscheme/{id}/default",
    "jira.workflow-scheme-draft": "/workflowscheme/{id}/draft",
    "jira.workflow-scheme-draft-default": "/workflowscheme/{id}/draft/default",
    "jira.workflow-scheme-issue-type": "/workflowscheme/{id}/issuetype/{issueType}",
    "jira.workflow-scheme-draft-issue-type": "/workflowscheme/{id}/draft/issuetype/{issueType}",
    "jira.workflow-scheme-workflows": "/workflowscheme/{id}/workflow",
    "jira.workflow-scheme-draft-workflows": "/workflowscheme/{id}/draft/workflow",
  }),
  ...reads("visible-screen-configuration", {
    "jira.screens": "/screens",
    "jira.screen-tabs": "/screens/{screenId}/tabs",
    "jira.screen-tab-fields": "/screens/{screenId}/tabs/{tabId}/fields",
    "jira.screen-available-fields": "/screens/{screenId}/availableFields",
  }),
  ...reads("visible-watchers", { "jira.watchers": "/issue/{issueIdOrKey}/watchers" }),
  ...reads("visible-voters", { "jira.votes": "/issue/{issueIdOrKey}/votes" }),
  ...reads("attachment-availability", { "jira.attachment-settings": "/attachment/meta" }),
  ...reads("visible-attachments", {
    "jira.attachment": "/attachment/{id}",
    "jira.attachment-archive": "/attachment/{id}/expand/raw",
    "jira.attachment-archive-summary": "/attachment/{id}/expand/human",
  }),
  ...reads("visible-avatars", {
    "jira.system-avatars": "/avatar/{type}/system",
    "jira.project-avatars": "/project/{projectIdOrKey}/avatars",
    "jira.user-avatars": "/user/avatars",
    "jira.avatars": "/universal_avatar/type/{type}/owner/{owningObjectId}",
  }),
  ...reads("visible-dashboards", {
    "jira.dashboards": "/dashboard", "jira.dashboard": "/dashboard/{id}",
    "jira.dashboard-item-property-keys": "/dashboard/{dashboardId}/items/{itemId}/properties",
    "jira.dashboard-item-property": "/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
  }),
  ...reads("authenticated-user-preferences", {
    "jira.filter-share-scope": "/filter/defaultShareScope",
    "jira.accessibility-settings": "/user/a11y/personal-settings",
  }),
  ...reads("visible-filter-permissions", {
    "jira.filter-permissions": "/filter/{id}/permission",
    "jira.filter-permission": "/filter/{id}/permission/{permissionId}",
  }),
  ...reads("visible-comments", {
    "jira.get-comment": "/issue/{issueIdOrKey}/comment/{id}",
    "jira.comment-property-keys": "/comment/{commentId}/properties",
    "jira.comment-property": "/comment/{commentId}/properties/{propertyKey}",
  }),
  ...reads("visible-link-types", {
    "jira.link-types": "/issueLinkType",
    "jira.link-type": "/issueLinkType/{issueLinkTypeId}",
  }),
  ...reads("visible-issue-links", { "jira.issue-link": "/issueLink/{linkId}" }),
  ...reads("visible-worklogs", {
    "jira.worklogs": "/issue/{issueIdOrKey}/worklog",
    "jira.worklog": "/issue/{issueIdOrKey}/worklog/{id}",
  }),
  ...reads("visible-components", {
    "jira.component-page": "/component/page",
    "jira.components": "/project/{projectIdOrKey}/components",
    "jira.component": "/component/{id}",
    "jira.component-related-issue-counts": "/component/{id}/relatedIssueCounts",
  }),
  ...reads("visible-versions", {
    "jira.global-version-page": "/version",
    "jira.versions": "/project/{projectIdOrKey}/versions",
    "jira.version": "/version/{id}",
    "jira.version-related-issue-counts": "/version/{id}/relatedIssueCounts",
    "jira.version-unresolved-issue-count": "/version/{id}/unresolvedIssueCount",
    "jira.project-version-page": "/project/{projectIdOrKey}/version",
  }),
  ...reads("visible-boards", {
    "jira.board-property-keys": "/board/{boardId}/properties",
    "jira.board-property": "/board/{boardId}/properties/{propertyKey}",
    "jira.boards": "/board",
    "jira.board": "/board/{boardId}",
    "jira.board-configuration": "/board/{boardId}/configuration",
    "jira.board-refined-velocity": "/board/{boardId}/settings/refined-velocity",
  }, "/rest/agile/1.0"),
  ...reads("visible-issues", {
    "jira.board-backlog": "/board/{boardId}/backlog",
    "jira.board-issues": "/board/{boardId}/issue",
    "jira.epic-issues": "/epic/{epicIdOrKey}/issue",
    "jira.sprint-issues": "/sprint/{sprintId}/issue",
    "jira.board-epicless-issues": "/board/{boardId}/epic/none/issue",
    "jira.board-epic-issues": "/board/{boardId}/epic/{epicId}/issue",
    "jira.board-sprint-issues": "/board/{boardId}/sprint/{sprintId}/issue",
    "jira.epicless-issues": "/epic/none/issue",
    "jira.agile-issue": "/issue/{issueIdOrKey}",
  }, "/rest/agile/1.0"),
  ...reads("visible-projects", {
    "jira.board-projects": "/board/{boardId}/project",
  }, "/rest/agile/1.0"),
  ...reads("visible-versions", {
    "jira.board-versions": "/board/{boardId}/version",
  }, "/rest/agile/1.0"),
  ...reads("board-issue-estimation", {
    "jira.issue-estimation": "/issue/{issueIdOrKey}/estimation",
  }, "/rest/agile/1.0"),
  ...reads("visible-epics", {
    "jira.board-epics": "/board/{boardId}/epic",
    "jira.epic": "/epic/{epicIdOrKey}",
  }, "/rest/agile/1.0"),
  ...reads("visible-sprints", {
    "jira.sprint-property-keys": "/sprint/{sprintId}/properties",
    "jira.sprint-property": "/sprint/{sprintId}/properties/{propertyKey}",
    "jira.sprints": "/board/{boardId}/sprint",
    "jira.sprint": "/sprint/{sprintId}",
  }, "/rest/agile/1.0"),
  ...reads("visible-filters", { "jira.filter": "/filter/{id}", "jira.favourite-filters": "/filter/favourite" }),
  ...reads("visible-projects", {
    "jira.projects": "/project",
    "jira.project-property-keys": "/project/{projectIdOrKey}/properties",
    "jira.project-property": "/project/{projectIdOrKey}/properties/{propertyKey}",
    "jira.project-picker": "/projects/picker",
  }),
  ...reads("current-project-metadata", {
    "jira.project-categories": "/projectCategory",
    "jira.project-category": "/projectCategory/{id}",
    "jira.project-statuses": "/project/{projectIdOrKey}/statuses",
    "jira.project-types": "/project/type",
    "jira.project-type-definition": "/project/type/{projectTypeKey}",
    "jira.project": "/project/{projectIdOrKey}",
    "jira.project-workflow-scheme": "/project/{projectKeyOrId}/workflowscheme",
    "jira.project-priority-scheme": "/project/{projectKeyOrId}/priorityscheme",
  }),
  ...reads("native-project-key-validation", { "jira.validate-project-key": "/projectvalidate/key" }),
  ...reads("explicit-project-permissions", { "jira.project-permissions": "/mypermissions" }),
  ...reads("accessible-project-type", { "jira.project-type": "/project/type/{projectTypeKey}/accessible" }),
  ...reads("current-create-metadata", {
    "jira.issue-types": "/issue/createmeta/{projectIdOrKey}/issuetypes",
    "jira.create-fields": "/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}",
  }),
  ...reads("current-edit-metadata", { "jira.edit-fields": "/issue/{issueIdOrKey}/editmeta" }),
  ...reads("visible-issues", {
    "jira.search": "/search",
    "jira.issue-property-keys": "/issue/{issueIdOrKey}/properties",
    "jira.issue-property": "/issue/{issueIdOrKey}/properties/{propertyKey}",
    "jira.issue": "/issue/{issueIdOrKey}",
    "jira.comments": "/issue/{issueIdOrKey}/comment",
  }),
  ...reads("current-transitions", { "jira.transitions": "/issue/{issueIdOrKey}/transitions" }),
  ...reads("current-assignable-users", { "jira.assignable-users": "/user/assignable/search" }),
  ...writes("current-user-watch-and-readback", {
    "jira.watch": ["POST", "/issue/{issueIdOrKey}/watchers"],
    "jira.unwatch": ["DELETE", "/issue/{issueIdOrKey}/watchers"],
  }),
  ...writes("current-user-vote-and-readback", {
    "jira.vote": ["POST", "/issue/{issueIdOrKey}/votes"],
    "jira.unvote": ["DELETE", "/issue/{issueIdOrKey}/votes"],
  }),
  ...writes("worklog-create-and-readback", { "jira.create-worklog": ["POST", "/issue/{issueIdOrKey}/worklog"] }),
  ...writes("worklog-update-and-readback", { "jira.update-worklog": ["PUT", "/issue/{issueIdOrKey}/worklog/{id}"] }),
  ...writes("worklog-delete-and-absence", { "jira.delete-worklog": ["DELETE", "/issue/{issueIdOrKey}/worklog/{id}"] }),
  ...writes("attachment-delete-and-absence", { "jira.delete-attachment": ["DELETE", "/attachment/{id}"] }),
  ...writes("comment-update-and-readback", { "jira.update-comment": ["PUT", "/issue/{issueIdOrKey}/comment/{id}"] }),
  ...writes("comment-delete-and-absence", { "jira.delete-comment": ["DELETE", "/issue/{issueIdOrKey}/comment/{id}"] }),
  ...writes("component-create-and-readback", { "jira.create-component": ["POST", "/component"] }),
  ...writes("component-update-and-readback", { "jira.update-component": ["PUT", "/component/{id}"] }),
  ...writes("version-create-and-readback", { "jira.create-version": ["POST", "/version"] }),
  ...writes("version-update-and-readback", { "jira.update-version": ["PUT", "/version/{id}"] }),
  ...writes("board-create-and-readback", { "jira.board-create": ["POST", "/board"] }, "/rest/agile/1.0"),
  ...writes("sprint-create-and-readback", { "jira.sprint-create": ["POST", "/sprint"] }, "/rest/agile/1.0"),
  ...writes("sprint-update-and-readback", { "jira.sprint-update": ["POST", "/sprint/{sprintId}"] }, "/rest/agile/1.0"),
  ...writes("issue-membership-and-readback", {
    "jira.sprint-move-issues": ["POST", "/sprint/{sprintId}/issue"],
    "jira.backlog-move-issues": ["POST", "/backlog/issue"],
    "jira.epic-move-issues": ["POST", "/epic/{epicIdOrKey}/issue"],
  }, "/rest/agile/1.0"),
  ...writes("epic-update-and-readback", { "jira.epic-update": ["POST", "/epic/{epicIdOrKey}"] }, "/rest/agile/1.0"),
  ...writes("project-create-and-readback", { "jira.create-project": ["POST", "/project"] }),
  ...writes("project-update-and-readback", { "jira.update-project": ["PUT", "/project/{projectIdOrKey}"] }),
  ...writes("current-create-metadata", { "jira.create": ["POST", "/issue"] }),
  ...writes("current-edit-metadata", { "jira.edit": ["PUT", "/issue/{issueIdOrKey}"] }),
  ...writes("current-assignable-users", { "jira.assign": ["PUT", "/issue/{issueIdOrKey}/assignee"] }),
  ...writes("comment-create-and-readback", { "jira.comment": ["POST", "/issue/{issueIdOrKey}/comment"] }),
  ...writes("current-transitions", { "jira.transition": ["POST", "/issue/{issueIdOrKey}/transitions"] }),
  ...writes("attachment-create-and-readback", { "jira.attach": ["POST", "/issue/{issueIdOrKey}/attachments"] }),
};
const COMPOSITES: Readonly<
  Record<
    CompositeTool,
    { readonly members: readonly JiraOperationTool[]; readonly local: JiraOperationEffect }
  >
> = {
  "jira.report": {
    members: ["jira.search", "jira.issue-types", "jira.create-fields"],
    local: "local-report",
  },
  "jira.draft-stage": { members: ["jira.create-fields"], local: "local-draft" },
  "jira.draft": { members: ["jira.create", "jira.edit"], local: "local-draft" },
};

function definitionFor(tool: string): JiraOperationDefinition {
  if (Object.hasOwn(NATIVE, tool)) {
    const name = tool as NativeTool;
    const [method, effect, pathTemplate, permissionPolicy, apiRoot = "/rest/api/2"] = NATIVE[name];
    return {
      tool: name,
      kind: "native",
      deployment: "data-center",
      identity: `${method} ${apiRoot}${pathTemplate}`,
      method,
      apiRoot,
      pathTemplate,
      effects: effect === "read" ? ["remote-read"] : ["remote-read", "remote-write"],
      authorityAction: JIRA_MANAGED_ACTION_TYPES[name],
      permissionPolicy,
      continuationPolicy:
        name === "jira.create" || name === "jira.edit" ? "approved-issue-links" : "none",
    };
  }
  if (!Object.hasOwn(COMPOSITES, tool)) throw new TypeError("Unknown Jira operation");
  const name = tool as CompositeTool;
  const composite = COMPOSITES[name];
  return {
    tool: name,
    kind: "composite",
    deployment: "data-center",
    identity: `composite:${name}`,
    members: composite.members,
    effects:
      name === "jira.draft"
        ? ["remote-read", "remote-write", composite.local]
        : ["remote-read", composite.local],
    authorityAction: JIRA_MANAGED_ACTION_TYPES[name],
    permissionPolicy: "composed-current-metadata",
  };
}

const BINDING_SCHEMA = {
  type: "object",
  properties: {
    identity: { type: "string", maxLength: 192 },
    contractDigest: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
  },
  required: ["identity", "contractDigest"],
  additionalProperties: false,
};
// Native identities contain ASCII only. Existing ceiling-sized producers already reserve 4 KiB.
const BINDING_RESULT_BYTES = 384;

function schemaObject(value: CatalogJsonValue | undefined): value is CatalogJsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}
function schemaRequired(value: CatalogJsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function resultDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  const { descriptorDigest: _digest, ...original } = descriptor;
  const properties = descriptor.resultSchema.properties;
  const required = descriptor.resultSchema.required;
  if (!schemaObject(properties) || !schemaRequired(required))
    throw new TypeError("Jira result must have an explicit object schema");
  return createToolDescriptor({
    ...original,
    toolRef: createToolRef(descriptor.toolRef.canonicalId, descriptor.toolRef.contractVersion + 1),
    resultSchema: {
      ...descriptor.resultSchema,
      properties: { ...properties, operationBinding: BINDING_SCHEMA },
      required: [...required, "operationBinding"],
    },
    bounds: {
      ...descriptor.bounds,
      maxResultBytes: Math.min(
        TOOL_CATALOG_LIMITS.maxResultBytes,
        descriptor.bounds.maxResultBytes + BINDING_RESULT_BYTES,
      ),
    },
  });
}

/** Pure authoring: existing typed schemas, effects and bounds remain owned by their declarations. */
export function createJiraOperationContract(
  declaration: ManagedMcpToolDeclaration,
  memberContract?: (tool: JiraOperationTool) => JiraOperationContract | undefined,
): JiraOperationContract {
  const definition = definitionFor(declaration.name);
  if (declaration.risk !== (definition.effects.includes("remote-write") ? "write" : "read"))
    throw new TypeError("Jira operation effect disagrees with its declaration");
  const projection = resultDescriptor(declaration.descriptor);
  const members =
    definition.kind === "native"
      ? []
      : definition.members.map((tool) => {
          const member = memberContract?.(tool);
          if (member?.definition.tool !== tool)
            throw new TypeError("Missing Jira composite member");
          return member.binding;
        });
  const binding = {
    identity: definition.identity,
    contractDigest: sha256Hex(
      canonicalise({
        domain: "keiko.jira-operation-contract.v1",
        definition,
        members,
        descriptorDigest: projection.descriptorDigest,
      }),
    ),
  };
  const { descriptorDigest: _digest, ...projected } = projection;
  const descriptor = createToolDescriptor({
    ...projected,
    policyReferences: [
      ...projection.policyReferences,
      `jira-operation-contract.${binding.contractDigest}`,
    ],
  });
  return deepFreeze({ definition, binding, declaration: { ...declaration, descriptor } });
}

/** Native contracts are bound first so a composite also pins its constituents' typed contracts. */
export function createJiraOperationContracts(
  declarations: readonly ManagedMcpToolDeclaration[],
): readonly JiraOperationContract[] {
  if (new Set(declarations.map((item) => item.name)).size !== declarations.length)
    throw new TypeError("Duplicate Jira operation declaration");
  const entries = new Map<string, JiraOperationContract>();
  for (const declaration of declarations) {
    if (definitionFor(declaration.name).kind === "native")
      entries.set(declaration.name, createJiraOperationContract(declaration));
  }
  for (const declaration of declarations) {
    if (definitionFor(declaration.name).kind === "composite")
      entries.set(
        declaration.name,
        createJiraOperationContract(declaration, (tool) => entries.get(tool)),
      );
  }
  return Object.freeze(
    declarations.map((declaration) => {
      const entry = entries.get(declaration.name);
      if (entry === undefined) throw new TypeError("Missing Jira operation contract");
      return entry;
    }),
  );
}

function bindingObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 && keys.every((key) => key === "identity" || key === "contractDigest");
}

/** Closed persisted snapshot shape; this does not admit execution against the current contract. */
export function isJiraOperationBinding(value: unknown): value is JiraOperationBinding {
  if (!bindingObject(value)) return false;
  const identity: unknown = Object.getOwnPropertyDescriptor(value, "identity")?.value;
  const digest: unknown = Object.getOwnPropertyDescriptor(value, "contractDigest")?.value;
  return (
    typeof identity === "string" &&
    /^[\u0020-\u007e]{1,192}$/u.test(identity) &&
    typeof digest === "string" &&
    /^[a-f0-9]{64}$/u.test(digest)
  );
}

/** The optional snapshot preserves historical transcript hashes; it never grants execution. */
export function jiraOperationActionDigest(
  operation: JiraMutationOperation,
  argumentsDigest: string,
  operationBinding?: JiraOperationBinding,
  sourceDigest?: string,
): string {
  return sha256Hex(
    canonicalise({
      operation,
      argumentsDigest,
      ...(operationBinding === undefined ? {} : { operationBinding }),
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
    }),
  );
}

/** Exact server snapshot; callers cannot supply URLs, extra authority fields or an old digest. */
export function matchesJiraOperationBinding(
  contract: JiraOperationContract,
  value: unknown,
): value is JiraOperationBinding {
  return (
    isJiraOperationBinding(value) &&
    value.identity === contract.binding.identity &&
    value.contractDigest === contract.binding.contractDigest
  );
}
