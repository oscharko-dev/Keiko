import {
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MUTATION_DETAIL_LIMITS,
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
import {
  createToolDescriptor,
  createToolRef,
  ToolCatalogError,
} from "@oscharko-dev/keiko-tool-catalog";

export type JiraOperationTool = JiraManagedReadToolName | JiraMutationOperation;
type CompositeTool = "jira.report" | "jira.draft-stage" | "jira.draft-batch" | "jira.draft";
type NativeTool = Exclude<JiraOperationTool, CompositeTool>;
type JiraOperationEffect = "remote-read" | "remote-write" | "local-report" | "local-draft";
type JiraPermissionPolicy = (typeof NATIVE)[NativeTool][3] | "composed-current-metadata";

interface OperationDefinitionBase {
  readonly tool: JiraOperationTool;
  readonly deployment: "data-center";
  readonly identity: string;
  readonly effects: readonly JiraOperationEffect[];
  /** Existing Keiko policy owner; the registry never grants permissions. */
  readonly authorityAction: (typeof JIRA_MANAGED_ACTION_TYPES)[JiraOperationTool];
  /** Existing handler metadata plus Jira's response remain the permission decision. */
  readonly permissionPolicy: JiraPermissionPolicy;
  /**
   * Present only where evidence shows a normal Jira user is refused (#4357). It selects the words of
   * a permission refusal; it grants nothing, hides nothing and is never inferred from a refusal.
   */
  readonly administration?: true;
}
export type JiraOperationDefinition = OperationDefinitionBase &
  (
    | {
        readonly kind: "native";
        readonly method: "GET" | "POST" | "PUT" | "DELETE";
        readonly apiRoot: "/rest/api/2" | "/rest/agile/1.0" | "/rest/auth/1";
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

type JiraApiRoot = "/rest/api/2" | "/rest/agile/1.0" | "/rest/auth/1";
type NativeSpecification<Policy extends string = string> = readonly [
  "GET" | "POST" | "PUT" | "DELETE",
  "read" | "write",
  string,
  Policy,
  JiraApiRoot?,
];
function operations<const K extends NativeTool, const Policy extends string>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  groups: Readonly<Record<Policy, Readonly<Partial<Record<K, string>>>>>,
  root: JiraApiRoot = "/rest/api/2",
): Readonly<Record<K, NativeSpecification<Policy>>> {
  const result: Partial<Record<K, NativeSpecification<Policy>>> = {};
  for (const permissionPolicy in groups) {
    if (!Object.hasOwn(groups, permissionPolicy)) continue;
    const paths: Readonly<Partial<Record<K, string>>> = groups[permissionPolicy];
    for (const tool in paths) {
      if (!Object.hasOwn(paths, tool)) continue;
      const path = paths[tool];
      if (path !== undefined)
        result[tool] = [method, method === "GET" ? "read" : "write", path, permissionPolicy, root];
    }
  }
  return result as Readonly<Record<K, NativeSpecification<Policy>>>;
}
const NATIVE = {
  ...operations("GET", {
    "authenticated-user-preferences": {
      "jira.accessibility-settings": "/user/a11y/personal-settings",
      "jira.filter-share-scope": "/filter/defaultShareScope",
    },
    "observed-application-settings": {
      "jira.advanced-settings": "/application-properties/advanced-settings",
      "jira.application-properties": "/application-properties",
      "jira.my-preference": "/mypreferences",
    },
    "instance-admin-anonymization-observation": {
      "jira.anonymization-progress": "/user/anonymization/progress",
      "jira.anonymization-rerun-validation": "/user/anonymization/rerun",
      "jira.anonymization-validation": "/user/anonymization",
    },
    "observed-maintenance-status": {
      "jira.app-monitoring": "/monitoring/app",
      "jira.cluster-nodes": "/cluster/nodes",
      "jira.cluster-upgrade-state": "/cluster/zdu/state",
      "jira.index-snapshot-status": "/index-snapshot/isRunning",
      "jira.index-snapshots": "/index-snapshot",
      "jira.index-summary": "/index/summary",
      "jira.ipd-monitoring": "/monitoring/ipd",
      "jira.jmx-metrics": "/monitoring/jmx/getAvailableMetrics",
      "jira.reindex-progress": "/reindex/progress",
      "jira.reindex-request": "/reindex/request/{requestId}",
      "jira.reindex-requests": "/reindex/request/bulk",
      "jira.reindex-status": "/reindex",
      "jira.upgrade-result": "/upgrade",
    },
    "admin-application-roles": {
      "jira.application-role": "/applicationrole/{key}",
      "jira.application-roles": "/applicationrole",
    },
    "current-assignable-users": {
      "jira.assignable-users": "/user/assignable/search",
    },
    "visible-attachments": {
      "jira.attachment": "/attachment/{id}",
      "jira.attachment-archive": "/attachment/{id}/expand/raw",
      "jira.attachment-archive-summary": "/attachment/{id}/expand/human",
    },
    "attachment-availability": {
      "jira.attachment-settings": "/attachment/meta",
    },
    "visible-avatars": {
      "jira.avatars": "/universal_avatar/type/{type}/owner/{owningObjectId}",
      "jira.project-avatars": "/project/{projectIdOrKey}/avatars",
      "jira.system-avatars": "/avatar/{type}/system",
      "jira.user-avatars": "/user/avatars",
    },
    "scoped-user-candidates": {
      "jira.browse-permission-users": "/user/viewissue/search",
      "jira.multi-project-assignable-users": "/user/assignable/multiProjectSearch",
      "jira.permission-users": "/user/permission/search",
    },
    "visible-comments": {
      "jira.comment-property": "/comment/{commentId}/properties/{propertyKey}",
      "jira.comment-property-keys": "/comment/{commentId}/properties",
      "jira.get-comment": "/issue/{issueIdOrKey}/comment/{id}",
      "jira.pinned-comments": "/issue/{issueIdOrKey}/pinned-comments",
    },
    "visible-issues": {
      "jira.comments": "/issue/{issueIdOrKey}/comment",
      "jira.issue": "/issue/{issueIdOrKey}",
      "jira.issue-picker": "/issue/picker",
      "jira.issue-property": "/issue/{issueIdOrKey}/properties/{propertyKey}",
      "jira.issue-property-keys": "/issue/{issueIdOrKey}/properties",
      "jira.search": "/search",
      "jira.subtask-move-availability": "/issue/{issueIdOrKey}/subtask/move",
      "jira.subtasks": "/issue/{issueIdOrKey}/subtask",
    },
    "visible-components": {
      "jira.component": "/component/{id}",
      "jira.component-page": "/component/page",
      "jira.component-related-issue-counts": "/component/{id}/relatedIssueCounts",
      "jira.components": "/project/{projectIdOrKey}/components",
    },
    "current-create-metadata": {
      "jira.create-fields": "/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}",
      "jira.issue-types": "/issue/createmeta/{projectIdOrKey}/issuetypes",
    },
    "visible-issue-metadata": {
      "jira.custom-field-option": "/customFieldOption/{id}",
      "jira.fields": "/field",
      "jira.global-issue-types": "/issuetype",
      "jira.issue-type": "/issuetype/{id}",
      "jira.issue-type-alternatives": "/issuetype/{id}/alternatives",
      "jira.issue-type-page": "/issuetype/page",
      "jira.issue-type-property": "/issuetype/{issueTypeId}/properties/{propertyKey}",
      "jira.issue-type-property-keys": "/issuetype/{issueTypeId}/properties",
      "jira.priorities": "/priority",
      "jira.priority": "/priority/{id}",
      "jira.priority-page": "/priority/page",
      "jira.resolution": "/resolution/{id}",
      "jira.resolution-page": "/resolution/page",
      "jira.resolutions": "/resolution",
      "jira.status": "/status/{idOrName}",
      "jira.status-categories": "/statuscategory",
      "jira.status-category": "/statuscategory/{idOrKey}",
      "jira.status-page": "/status/page",
      "jira.statuses": "/status",
    },
    "visible-custom-field-configuration": {
      "jira.custom-field-options": "/customFields/{customFieldId}/options",
      "jira.custom-fields": "/customFields",
    },
    "visible-dashboards": {
      "jira.dashboard": "/dashboard/{id}",
      "jira.dashboard-item-property":
        "/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
      "jira.dashboard-item-property-keys": "/dashboard/{dashboardId}/items/{itemId}/properties",
      "jira.dashboards": "/dashboard",
    },
    "native-visible-worklog-change-window": {
      "jira.deleted-worklogs": "/worklog/deleted",
      "jira.updated-worklogs": "/worklog/updated",
    },
    "observed-account-diagnostics": {
      "jira.duplicate-user-count": "/user/duplicated/count",
      "jira.duplicate-users": "/user/duplicated/list",
      "jira.password-policy": "/password/policy",
      "jira.search-error": "/search/error/lookup",
    },
    "current-edit-metadata": {
      "jira.edit-fields": "/issue/{issueIdOrKey}/editmeta",
    },
    "instance-admin-email-template-archive-observation": {
      "jira.email-template-pack": "/email-templates",
    },
    "admin-email-template-metadata": {
      "jira.email-template-types": "/email-templates/types",
    },
    "visible-filters": {
      "jira.favourite-filters": "/filter/favourite",
      "jira.filter": "/filter/{id}",
    },
    "observed-column-layout": {
      "jira.filter-columns": "/filter/{id}/columns",
      "jira.system-columns": "/settings/columns",
      "jira.user-columns": "/user/columns",
    },
    "visible-filter-permissions": {
      "jira.filter-permission": "/filter/{id}/permission/{permissionId}",
      "jira.filter-permissions": "/filter/{id}/permission",
    },
    "visible-versions": {
      "jira.global-version-page": "/version",
      "jira.project-version-page": "/project/{projectIdOrKey}/version",
      "jira.version": "/version/{id}",
      "jira.version-related-issue-counts": "/version/{id}/relatedIssueCounts",
      "jira.version-unresolved-issue-count": "/version/{id}/unresolvedIssueCount",
      "jira.versions": "/project/{projectIdOrKey}/versions",
    },
    "visible-groups": {
      "jira.group-members": "/group/member",
      "jira.groups": "/groups/picker",
    },
    "visible-directory-suggestions": {
      "jira.group-user-picker": "/groupuserpicker",
    },
    "observed-instance-metadata": {
      "jira.instance-configuration": "/configuration",
      "jira.jmx-metrics-exposed": "/monitoring/jmx/areMetricsExposed",
      "jira.read-only-mode": "/readonly-mode",
      "jira.search-max-aggregation-buckets": "/searchLimits/maxAggregationBuckets",
      "jira.search-max-result-window": "/searchLimits/maxResultWindow",
      "jira.server-info": "/serverInfo",
    },
    "visible-issue-links": {
      "jira.issue-link": "/issueLink/{linkId}",
      "jira.remote-link": "/issue/{issueIdOrKey}/remotelink/{linkId}",
      "jira.remote-links": "/issue/{issueIdOrKey}/remotelink",
    },
    "visible-security-configuration": {
      "jira.issue-security-scheme": "/issuesecurityschemes/{id}",
      "jira.issue-security-schemes": "/issuesecurityschemes",
      "jira.project-issue-security-scheme": "/project/{projectKeyOrId}/issuesecuritylevelscheme",
      "jira.project-security-levels": "/project/{projectKeyOrId}/securitylevel",
      "jira.security-level": "/securitylevel/{id}",
    },
    "admin-issue-type-schemes": {
      "jira.issue-type-scheme": "/issuetypescheme/{schemeId}",
      "jira.issue-type-scheme-projects": "/issuetypescheme/{schemeId}/associations",
      "jira.issue-type-schemes": "/issuetypescheme",
    },
    "visible-jql-metadata": {
      "jira.jql-autocomplete": "/jql/autocompletedata",
      "jira.jql-suggestions": "/jql/autocompletedata/suggestions",
    },
    "visible-link-types": {
      "jira.link-type": "/issueLinkType/{issueLinkTypeId}",
      "jira.link-types": "/issueLinkType",
    },
    "current-actor-metadata": {
      "jira.myself": "/myself",
    },
    "visible-notification-configuration": {
      "jira.notification-scheme": "/notificationscheme/{id}",
      "jira.notification-schemes": "/notificationscheme",
      "jira.project-notification-scheme": "/project/{projectKeyOrId}/notificationscheme",
    },
    "permission-definitions": {
      "jira.permission-definitions": "/permissions",
    },
    "visible-permission-configuration": {
      "jira.permission-grant": "/permissionscheme/{schemeId}/permission/{permissionId}",
      "jira.permission-grants": "/permissionscheme/{schemeId}/permission",
      "jira.permission-scheme": "/permissionscheme/{schemeId}",
      "jira.permission-scheme-attribute":
        "/permissionscheme/{permissionSchemeId}/attribute/{attributeKey}",
      "jira.permission-schemes": "/permissionscheme",
      "jira.project-permission-scheme": "/project/{projectKeyOrId}/permissionscheme",
    },
    "visible-priority-configuration": {
      "jira.priority-scheme": "/priorityschemes/{schemeId}",
      "jira.priority-schemes": "/priorityschemes",
    },
    "current-project-metadata": {
      "jira.project": "/project/{projectIdOrKey}",
      "jira.project-categories": "/projectCategory",
      "jira.project-category": "/projectCategory/{id}",
      "jira.project-priority-scheme": "/project/{projectKeyOrId}/priorityscheme",
      "jira.project-statuses": "/project/{projectIdOrKey}/statuses",
      "jira.project-type-definition": "/project/type/{projectTypeKey}",
      "jira.project-types": "/project/type",
      "jira.project-workflow-scheme": "/project/{projectKeyOrId}/workflowscheme",
    },
    "explicit-project-permissions": {
      "jira.project-permissions": "/mypermissions",
    },
    "visible-projects": {
      "jira.project-picker": "/projects/picker",
      "jira.project-property": "/project/{projectIdOrKey}/properties/{propertyKey}",
      "jira.project-property-keys": "/project/{projectIdOrKey}/properties",
      "jira.projects": "/project",
    },
    "visible-role-configuration": {
      "jira.project-role": "/project/{projectIdOrKey}/role/{id}",
      "jira.project-roles": "/project/{projectIdOrKey}/role",
      "jira.role": "/role/{id}",
      "jira.role-default-actors": "/role/{id}/actors",
      "jira.roles": "/role",
    },
    "accessible-project-type": {
      "jira.project-type": "/project/type/{projectTypeKey}/accessible",
    },
    "native-version-remote-links": {
      "jira.remote-version-links": "/version/remotelink",
      "jira.version-remote-link": "/version/{versionId}/remotelink/{globalId}",
      "jira.version-remote-links": "/version/{versionId}/remotelink",
    },
    "visible-screen-configuration": {
      "jira.screen-available-fields": "/screens/{screenId}/availableFields",
      "jira.screen-tab-fields": "/screens/{screenId}/tabs/{tabId}/fields",
      "jira.screen-tabs": "/screens/{screenId}/tabs",
      "jira.screens": "/screens",
    },
    "observed-terminology": {
      "jira.terminology": "/terminology/entries",
      "jira.terminology-entry": "/terminology/entries/{originalName}",
    },
    "current-transitions": {
      "jira.transitions": "/issue/{issueIdOrKey}/transitions",
    },
    "visible-users": {
      "jira.user": "/user",
      "jira.user-directory": "/user/list",
      "jira.user-picker": "/user/picker",
      "jira.user-property": "/user/properties/{propertyKey}",
      "jira.user-property-keys": "/user/properties",
      "jira.users": "/user/search",
    },
    "native-project-key-validation": {
      "jira.validate-project-key": "/projectvalidate/key",
    },
    "visible-voters": {
      "jira.votes": "/issue/{issueIdOrKey}/votes",
    },
    "visible-watchers": {
      "jira.watchers": "/issue/{issueIdOrKey}/watchers",
    },
    "admin-workflow-schemes": {
      "jira.workflow-scheme": "/workflowscheme/{id}",
      "jira.workflow-scheme-default": "/workflowscheme/{id}/default",
      "jira.workflow-scheme-draft": "/workflowscheme/{id}/draft",
      "jira.workflow-scheme-draft-default": "/workflowscheme/{id}/draft/default",
      "jira.workflow-scheme-draft-issue-type": "/workflowscheme/{id}/draft/issuetype/{issueType}",
      "jira.workflow-scheme-draft-workflows": "/workflowscheme/{id}/draft/workflow",
      "jira.workflow-scheme-issue-type": "/workflowscheme/{id}/issuetype/{issueType}",
      "jira.workflow-scheme-workflows": "/workflowscheme/{id}/workflow",
    },
    "admin-workflow-configuration": {
      "jira.workflows": "/workflow",
    },
    "visible-worklogs": {
      "jira.worklog": "/issue/{issueIdOrKey}/worklog/{id}",
      "jira.worklogs": "/issue/{issueIdOrKey}/worklog",
    },
  }),
  ...operations("POST", {
    "instance-admin-default-screen-field-unconfirmed": {
      "jira.add-default-screen-field": "/screens/addToDefault/{fieldId}",
    },
    "instance-admin-filter-permission-and-readback": {
      "jira.add-filter-permission": "/filter/{id}/permission",
    },
    "instance-admin-group-membership-unconfirmed": {
      "jira.add-group-user": "/group/user",
    },
    "instance-admin-issue-type-scheme-projects-unconfirmed": {
      "jira.add-issue-type-scheme-projects": "/issuetypescheme/{schemeId}/associations",
    },
    "instance-admin-permission-grant-add-and-readback": {
      "jira.add-permission-grant": "/permissionscheme/{schemeId}/permission",
    },
    "instance-admin-project-role-actors-unconfirmed": {
      "jira.add-project-role-actors": "/project/{projectIdOrKey}/role/{id}",
    },
    "instance-admin-role-default-actors-unconfirmed": {
      "jira.add-role-default-actors": "/role/{id}/actors",
    },
    "instance-admin-screen-field-add-and-readback": {
      "jira.add-screen-tab-field": "/screens/{screenId}/tabs/{tabId}/fields",
    },
    "instance-admin-user-application-unconfirmed": {
      "jira.add-user-application": "/user/application",
    },
    "instance-admin-email-template-apply-unconfirmed": {
      "jira.apply-email-template-pack": "/email-templates/apply",
    },
    "instance-admin-maintenance-request-unconfirmed": {
      "jira.approve-cluster-upgrade": "/cluster/zdu/approve",
      "jira.cancel-cluster-upgrade": "/cluster/zdu/cancel",
      "jira.create-index-snapshot": "/index-snapshot",
      "jira.process-reindex-requests": "/reindex/request",
      "jira.reindex-issues": "/reindex/issue",
      "jira.retry-cluster-upgrade": "/cluster/zdu/retryUpgrade",
      "jira.run-upgrade": "/upgrade",
      "jira.start-cluster-upgrade": "/cluster/zdu/start",
      "jira.start-reindex": "/reindex",
    },
    "issue-lifecycle-and-uncertainty": {
      "jira.archive-issues": "/issue/archive",
      "jira.move-subtask": "/issue/{issueIdOrKey}/subtask/move",
    },
    "attachment-create-and-readback": {
      "jira.attach": "/issue/{issueIdOrKey}/attachments",
    },
    "comment-create-and-readback": {
      "jira.comment": "/issue/{issueIdOrKey}/comment",
    },
    "current-create-metadata": {
      "jira.create": "/issue",
    },
    "component-create-and-readback": {
      "jira.create-component": "/component",
    },
    "instance-admin-custom-field-create-unconfirmed": {
      "jira.create-custom-field": "/field",
    },
    "instance-admin-filter-create-default-sharing": {
      "jira.create-filter": "/filter",
    },
    "instance-admin-group-create-and-readback": {
      "jira.create-group": "/group",
    },
    "issue-link-create-and-readback": {
      "jira.create-issue-link": "/issueLink",
    },
    "instance-admin-issue-type-create-unconfirmed": {
      "jira.create-issue-type": "/issuetype",
    },
    "instance-admin-avatar-session-and-uncertainty": {
      "jira.create-issue-type-avatar": "/issuetype/{id}/avatar",
      "jira.create-owned-avatar": "/universal_avatar/type/{type}/owner/{owningObjectId}/avatar",
      "jira.create-project-avatar": "/project/{projectIdOrKey}/avatar",
      "jira.create-user-avatar": "/user/avatar",
      "jira.crop-temporary-avatar": "/avatar/{type}/temporaryCrop",
      "jira.upload-issue-type-avatar": "/issuetype/{id}/avatar/temporary",
      "jira.upload-owned-avatar": "/universal_avatar/type/{type}/owner/{owningObjectId}/temp",
      "jira.upload-project-avatar": "/project/{projectIdOrKey}/avatar/temporary",
      "jira.upload-temporary-avatar": "/avatar/{type}/temporary",
      "jira.upload-user-avatar": "/user/avatar/temporary",
    },
    "instance-admin-issue-type-scheme-config-and-readback": {
      "jira.create-issue-type-scheme": "/issuetypescheme",
    },
    "bulk-current-metadata-and-uncertainty": {
      "jira.create-issues": "/issue/bulk",
    },
    "instance-admin-link-type-create-and-readback": {
      "jira.create-link-type": "/issueLinkType",
    },
    "instance-admin-permission-scheme-create-and-readback": {
      "jira.create-permission-scheme": "/permissionscheme",
    },
    "instance-admin-priority-scheme-config-and-readback": {
      "jira.create-priority-scheme": "/priorityschemes",
    },
    "project-create-and-readback": {
      "jira.create-project": "/project",
    },
    "instance-admin-project-category-create-and-readback": {
      "jira.create-project-category": "/projectCategory",
    },
    "instance-admin-configured-reciprocal-link-and-uncertainty": {
      "jira.create-reciprocal-remote-link": "/issue/remotelink/reciprocal",
    },
    "instance-admin-role-create-and-readback": {
      "jira.create-role": "/role",
    },
    "instance-admin-screen-tab-create-and-readback": {
      "jira.create-screen-tab": "/screens/{screenId}/tabs",
    },
    "instance-admin-user-lifecycle-and-uncertainty": {
      "jira.create-user": "/user",
      "jira.rerun-user-anonymization": "/user/anonymization/rerun",
      "jira.schedule-user-anonymization": "/user/anonymization",
    },
    "version-create-and-readback": {
      "jira.create-version": "/version",
    },
    "instance-admin-workflow-scheme-config-and-readback": {
      "jira.create-workflow-scheme": "/workflowscheme",
    },
    "instance-admin-workflow-draft-config-and-readback": {
      "jira.create-workflow-scheme-draft": "/workflowscheme/{id}/createdraft",
    },
    "worklog-create-and-readback": {
      "jira.create-worklog": "/issue/{issueIdOrKey}/worklog",
    },
    "instance-admin-screen-tab-order-and-readback": {
      "jira.move-screen-tab": "/screens/{screenId}/tabs/{tabId}/move/{pos}",
    },
    "instance-admin-screen-field-order-and-readback": {
      "jira.move-screen-tab-field": "/screens/{screenId}/tabs/{tabId}/fields/{id}/move",
    },
    "version-order-and-readback": {
      "jira.move-version": "/version/{id}/move",
    },
    "issue-notification-unconfirmed": {
      "jira.notify-issue": "/issue/{issueIdOrKey}/notify",
    },
    "version-delete-swap-and-reference-uncertainty": {
      "jira.remove-and-swap-version": "/version/{id}/removeAndSwap",
    },
    "instance-admin-email-template-revert-unconfirmed": {
      "jira.revert-email-template-pack": "/email-templates/revert",
    },
    "instance-admin-monitoring-state-and-readback": {
      "jira.set-app-monitoring": "/monitoring/app",
      "jira.set-ipd-monitoring": "/monitoring/ipd",
      "jira.start-jmx-metrics": "/monitoring/jmx/startExposing",
      "jira.stop-jmx-metrics": "/monitoring/jmx/stopExposing",
    },
    "instance-admin-terminology-and-readback": {
      "jira.set-terminology": "/terminology/entries",
    },
    "current-transitions": {
      "jira.transition": "/issue/{issueIdOrKey}/transitions",
    },
    "instance-admin-role-update-and-readback": {
      "jira.update-role": "/role/{id}",
    },
    "instance-admin-email-template-upload-unconfirmed": {
      "jira.upload-email-template-pack": "/email-templates",
    },
    "remote-link-upsert-and-readback": {
      "jira.upsert-remote-link": "/issue/{issueIdOrKey}/remotelink",
    },
    "version-remote-link-upsert-and-readback": {
      "jira.upsert-version-remote-link": "/version/{versionId}/remotelink",
      "jira.upsert-version-remote-link-by-global-id": "/version/{versionId}/remotelink/{globalId}",
    },
    "current-user-vote-and-readback": {
      "jira.vote": "/issue/{issueIdOrKey}/votes",
    },
    "current-user-watch-and-readback": {
      "jira.watch": "/issue/{issueIdOrKey}/watchers",
    },
  }),
  ...operations("PUT", {
    "issue-lifecycle-and-uncertainty": {
      "jira.archive-issue": "/issue/{issueIdOrKey}/archive",
      "jira.restore-issue": "/issue/{issueIdOrKey}/restore",
    },
    "instance-admin-project-lifecycle-and-uncertainty": {
      "jira.archive-project": "/project/{projectIdOrKey}/archive",
      "jira.restore-project": "/project/{projectIdOrKey}/restore",
      "jira.set-project-permission-scheme": "/project/{projectKeyOrId}/permissionscheme",
      "jira.set-project-priority-scheme": "/project/{projectKeyOrId}/priorityscheme",
      "jira.update-project-type": "/project/{projectIdOrKey}/type/{newProjectTypeKey}",
    },
    "current-assignable-users": {
      "jira.assign": "/issue/{issueIdOrKey}/assignee",
    },
    "current-edit-metadata": {
      "jira.edit": "/issue/{issueIdOrKey}",
    },
    "instance-admin-maintenance-request-unconfirmed": {
      "jira.mark-cluster-node-offline": "/cluster/node/{nodeId}/offline",
      "jira.request-cluster-index-snapshot": "/cluster/index-snapshot/{nodeId}",
    },
    "version-merge-and-reference-uncertainty": {
      "jira.merge-version": "/version/{id}/mergeto/{moveIssuesTo}",
    },
    "instance-admin-link-type-order-unconfirmed": {
      "jira.move-link-type": "/issueLinkType/{issueLinkTypeId}/order",
      "jira.reset-link-type-order": "/issueLinkType/order",
    },
    "comment-pin-and-readback": {
      "jira.pin-comment": "/issue/{issueIdOrKey}/comment/{id}/pin",
    },
    "instance-admin-screen-tab-rename-and-readback": {
      "jira.rename-screen-tab": "/screens/{screenId}/tabs/{tabId}",
    },
    "instance-admin-role-replace-and-readback": {
      "jira.replace-role": "/role/{id}",
    },
    "instance-admin-application-property-and-readback": {
      "jira.set-application-property": "/application-properties/{id}",
    },
    "instance-admin-application-role-cas-unconfirmed": {
      "jira.set-application-role": "/applicationrole/{key}",
      "jira.set-application-roles": "/applicationrole",
    },
    "entity-property-and-readback": {
      "jira.set-comment-property": "/comment/{commentId}/properties/{propertyKey}",
      "jira.set-dashboard-item-property":
        "/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
      "jira.set-issue-property": "/issue/{issueIdOrKey}/properties/{propertyKey}",
      "jira.set-project-property": "/project/{projectIdOrKey}/properties/{propertyKey}",
    },
    "owned-filter-columns-and-readback": {
      "jira.set-filter-columns": "/filter/{id}/columns",
    },
    "instance-admin-default-filter-sharing": {
      "jira.set-filter-share-scope": "/filter/defaultShareScope",
    },
    "instance-admin-base-url-config-unconfirmed": {
      "jira.set-instance-base-url": "/settings/baseUrl",
    },
    "instance-admin-entity-property-and-readback": {
      "jira.set-issue-type-property": "/issuetype/{issueTypeId}/properties/{propertyKey}",
      "jira.set-user-property": "/user/properties/{propertyKey}",
    },
    "instance-admin-issue-type-scheme-projects-unconfirmed": {
      "jira.set-issue-type-scheme-projects": "/issuetypescheme/{schemeId}/associations",
    },
    "current-user-preference-and-readback": {
      "jira.set-my-preference": "/mypreferences",
    },
    "instance-admin-permission-attribute-and-readback": {
      "jira.set-permission-scheme-attribute":
        "/permissionscheme/{permissionSchemeId}/attribute/{key}",
    },
    "instance-admin-avatar-session-and-uncertainty": {
      "jira.set-project-avatar": "/project/{projectIdOrKey}/avatar",
      "jira.set-user-avatar": "/user/avatar",
    },
    "instance-admin-project-role-actors-unconfirmed": {
      "jira.set-project-role-actors": "/project/{projectIdOrKey}/role/{id}",
    },
    "instance-admin-read-only-config-and-readback": {
      "jira.set-read-only-mode": "/readonly-mode",
    },
    "instance-admin-screen-field-display-and-readback": {
      "jira.set-screen-field-show-when-empty":
        "/screens/{screenId}/tabs/{tabId}/fields/{id}/updateShowWhenEmptyIndicator/{newValue}",
    },
    "instance-admin-system-columns-and-readback": {
      "jira.set-system-columns": "/settings/columns",
    },
    "instance-admin-user-columns-and-readback": {
      "jira.set-user-columns": "/user/columns",
    },
    "instance-admin-workflow-scheme-mapping-unconfirmed": {
      "jira.set-workflow-scheme-default": "/workflowscheme/{id}/default",
      "jira.set-workflow-scheme-issue-type": "/workflowscheme/{id}/issuetype/{issueType}",
      "jira.set-workflow-scheme-workflow": "/workflowscheme/{id}/workflow",
    },
    "instance-admin-workflow-draft-config-and-readback": {
      "jira.set-workflow-scheme-draft-default": "/workflowscheme/{id}/draft/default",
      "jira.set-workflow-scheme-draft-issue-type":
        "/workflowscheme/{id}/draft/issuetype/{issueType}",
      "jira.set-workflow-scheme-draft-workflow": "/workflowscheme/{id}/draft/workflow",
      "jira.update-workflow-scheme-draft": "/workflowscheme/{id}/draft",
    },
    "comment-update-and-readback": {
      "jira.update-comment": "/issue/{issueIdOrKey}/comment/{id}",
    },
    "component-update-and-readback": {
      "jira.update-component": "/component/{id}",
    },
    "owned-filter-metadata-and-readback": {
      "jira.update-filter": "/filter/{id}",
    },
    "instance-admin-issue-type-update-and-readback": {
      "jira.update-issue-type": "/issuetype/{id}",
    },
    "instance-admin-issue-type-scheme-config-and-readback": {
      "jira.update-issue-type-scheme": "/issuetypescheme/{schemeId}",
    },
    "instance-admin-link-type-update-and-readback": {
      "jira.update-link-type": "/issueLinkType/{issueLinkTypeId}",
    },
    "bound-protected-account-and-readback": {
      "jira.update-my-password": "/myself/password",
      "jira.update-myself": "/myself",
    },
    "instance-admin-permission-scheme-update-and-readback": {
      "jira.update-permission-scheme": "/permissionscheme/{schemeId}",
    },
    "instance-admin-priority-scheme-config-and-readback": {
      "jira.update-priority-scheme": "/priorityschemes/{schemeId}",
    },
    "project-update-and-readback": {
      "jira.update-project": "/project/{projectIdOrKey}",
    },
    "instance-admin-project-category-update-and-readback": {
      "jira.update-project-category": "/projectCategory/{id}",
    },
    "remote-link-update-and-readback": {
      "jira.update-remote-link": "/issue/{issueIdOrKey}/remotelink/{linkId}",
    },
    "instance-admin-user-lifecycle-and-uncertainty": {
      "jira.update-user": "/user",
      "jira.update-user-password": "/user/password",
    },
    "version-update-and-readback": {
      "jira.update-version": "/version/{id}",
    },
    "instance-admin-workflow-scheme-update-and-scope-uncertainty": {
      "jira.update-workflow-scheme": "/workflowscheme/{id}",
    },
    "worklog-update-and-readback": {
      "jira.update-worklog": "/issue/{issueIdOrKey}/worklog/{id}",
    },
  }),
  ...operations("DELETE", {
    "instance-admin-issue-type-scheme-projects-unconfirmed": {
      "jira.clear-issue-type-scheme-projects": "/issuetypescheme/{schemeId}/associations",
      "jira.remove-issue-type-scheme-project":
        "/issuetypescheme/{schemeId}/associations/{projIdOrKey}",
    },
    "attachment-delete-and-absence": {
      "jira.delete-attachment": "/attachment/{id}",
    },
    "instance-admin-maintenance-request-unconfirmed": {
      "jira.delete-cluster-node": "/cluster/node/{nodeId}",
    },
    "comment-delete-and-absence": {
      "jira.delete-comment": "/issue/{issueIdOrKey}/comment/{id}",
    },
    "entity-property-and-readback": {
      "jira.delete-comment-property": "/comment/{commentId}/properties/{propertyKey}",
      "jira.delete-dashboard-item-property":
        "/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
      "jira.delete-issue-property": "/issue/{issueIdOrKey}/properties/{propertyKey}",
      "jira.delete-project-property": "/project/{projectIdOrKey}/properties/{propertyKey}",
    },
    "component-delete-and-reference-uncertainty": {
      "jira.delete-component": "/component/{id}",
    },
    "instance-admin-custom-field-delete-unconfirmed": {
      "jira.delete-custom-fields": "/customFields",
    },
    "owned-filter-delete-unconfirmed": {
      "jira.delete-filter": "/filter/{id}",
    },
    "instance-admin-filter-permission-and-readback": {
      "jira.delete-filter-permission": "/filter/{id}/permission/{permission-id}",
    },
    "instance-admin-group-delete-unconfirmed": {
      "jira.delete-group": "/group",
    },
    "issue-lifecycle-and-uncertainty": {
      "jira.delete-issue": "/issue/{issueIdOrKey}",
    },
    "issue-link-delete-and-absence": {
      "jira.delete-issue-link": "/issueLink/{linkId}",
    },
    "instance-admin-issue-type-delete-and-migration-unconfirmed": {
      "jira.delete-issue-type": "/issuetype/{id}",
    },
    "instance-admin-entity-property-and-readback": {
      "jira.delete-issue-type-property": "/issuetype/{issueTypeId}/properties/{propertyKey}",
      "jira.delete-user-property": "/user/properties/{propertyKey}",
    },
    "instance-admin-issue-type-scheme-delete-unconfirmed": {
      "jira.delete-issue-type-scheme": "/issuetypescheme/{schemeId}",
    },
    "instance-admin-link-type-delete-unconfirmed": {
      "jira.delete-link-type": "/issueLinkType/{issueLinkTypeId}",
    },
    "current-user-preference-delete-unconfirmed": {
      "jira.delete-my-preference": "/mypreferences",
    },
    "instance-admin-avatar-session-and-uncertainty": {
      "jira.delete-owned-avatar":
        "/universal_avatar/type/{type}/owner/{owningObjectId}/avatar/{id}",
      "jira.delete-project-avatar": "/project/{projectIdOrKey}/avatar/{id}",
      "jira.delete-user-avatar": "/user/avatar/{id}",
    },
    "instance-admin-permission-grant-delete-and-absence": {
      "jira.delete-permission-grant": "/permissionscheme/{schemeId}/permission/{permissionId}",
    },
    "instance-admin-permission-scheme-delete-unconfirmed": {
      "jira.delete-permission-scheme": "/permissionscheme/{schemeId}",
    },
    "instance-admin-priority-scheme-delete-unconfirmed": {
      "jira.delete-priority-scheme": "/priorityschemes/{schemeId}",
    },
    "instance-admin-project-lifecycle-and-uncertainty": {
      "jira.delete-project": "/project/{projectIdOrKey}",
      "jira.remove-project-priority-scheme": "/project/{projectKeyOrId}/priorityscheme/{schemeId}",
    },
    "instance-admin-project-category-delete-unconfirmed": {
      "jira.delete-project-category": "/projectCategory/{id}",
    },
    "instance-admin-project-role-actors-unconfirmed": {
      "jira.delete-project-role-actor": "/project/{projectIdOrKey}/role/{id}",
    },
    "remote-link-delete-and-absence": {
      "jira.delete-remote-link": "/issue/{issueIdOrKey}/remotelink/{linkId}",
      "jira.delete-remote-link-by-global-id": "/issue/{issueIdOrKey}/remotelink",
    },
    "instance-admin-role-delete-unconfirmed": {
      "jira.delete-role": "/role/{id}",
    },
    "instance-admin-role-default-actors-unconfirmed": {
      "jira.delete-role-default-actor": "/role/{id}/actors",
    },
    "instance-admin-screen-tab-delete-and-absence": {
      "jira.delete-screen-tab": "/screens/{screenId}/tabs/{tabId}",
    },
    "instance-admin-user-lifecycle-and-uncertainty": {
      "jira.delete-user": "/user",
      "jira.invalidate-user-session": "/user/session/{username}",
    },
    "version-remote-link-delete-and-absence": {
      "jira.delete-version-remote-link": "/version/{versionId}/remotelink/{globalId}",
    },
    "version-remote-links-delete-and-absence": {
      "jira.delete-version-remote-links": "/version/{versionId}/remotelink",
    },
    "instance-admin-workflow-scheme-delete-unconfirmed": {
      "jira.delete-workflow-scheme": "/workflowscheme/{id}",
    },
    "instance-admin-workflow-scheme-mapping-unconfirmed": {
      "jira.delete-workflow-scheme-default": "/workflowscheme/{id}/default",
      "jira.delete-workflow-scheme-issue-type": "/workflowscheme/{id}/issuetype/{issueType}",
      "jira.delete-workflow-scheme-workflow": "/workflowscheme/{id}/workflow",
    },
    "instance-admin-workflow-draft-delete-and-parent-readback": {
      "jira.delete-workflow-scheme-draft": "/workflowscheme/{id}/draft",
    },
    "instance-admin-workflow-draft-config-and-readback": {
      "jira.delete-workflow-scheme-draft-default": "/workflowscheme/{id}/draft/default",
      "jira.delete-workflow-scheme-draft-issue-type":
        "/workflowscheme/{id}/draft/issuetype/{issueType}",
      "jira.delete-workflow-scheme-draft-workflow": "/workflowscheme/{id}/draft/workflow",
    },
    "worklog-delete-and-absence": {
      "jira.delete-worklog": "/issue/{issueIdOrKey}/worklog/{id}",
    },
    "instance-admin-group-membership-unconfirmed": {
      "jira.remove-group-user": "/group/user",
    },
    "instance-admin-screen-field-delete-and-absence": {
      "jira.remove-screen-tab-field": "/screens/{screenId}/tabs/{tabId}/fields/{id}",
    },
    "instance-admin-user-application-unconfirmed": {
      "jira.remove-user-application": "/user/application",
    },
    "owned-filter-columns-and-readback": {
      "jira.reset-filter-columns": "/filter/{id}/columns",
    },
    "instance-admin-user-columns-reset-unconfirmed": {
      "jira.reset-user-columns": "/user/columns",
    },
    "instance-admin-human-attested-anonymization-unlock": {
      "jira.unlock-user-anonymization": "/user/anonymization/unlock",
    },
    "current-user-vote-and-readback": {
      "jira.unvote": "/issue/{issueIdOrKey}/votes",
    },
    "current-user-watch-and-readback": {
      "jira.unwatch": "/issue/{issueIdOrKey}/watchers",
    },
  }),
  ...operations(
    "GET",
    {
      "visible-issues": {
        "jira.agile-issue": "/issue/{issueIdOrKey}",
        "jira.board-backlog": "/board/{boardId}/backlog",
        "jira.board-epic-issues": "/board/{boardId}/epic/{epicId}/issue",
        "jira.board-epicless-issues": "/board/{boardId}/epic/none/issue",
        "jira.board-issues": "/board/{boardId}/issue",
        "jira.board-sprint-issues": "/board/{boardId}/sprint/{sprintId}/issue",
        "jira.epic-issues": "/epic/{epicIdOrKey}/issue",
        "jira.epicless-issues": "/epic/none/issue",
        "jira.sprint-issues": "/sprint/{sprintId}/issue",
      },
      "visible-boards": {
        "jira.board": "/board/{boardId}",
        "jira.board-configuration": "/board/{boardId}/configuration",
        "jira.board-property": "/board/{boardId}/properties/{propertyKey}",
        "jira.board-property-keys": "/board/{boardId}/properties",
        "jira.board-refined-velocity": "/board/{boardId}/settings/refined-velocity",
        "jira.boards": "/board",
      },
      "visible-epics": {
        "jira.board-epics": "/board/{boardId}/epic",
        "jira.epic": "/epic/{epicIdOrKey}",
      },
      "visible-projects": {
        "jira.board-projects": "/board/{boardId}/project",
      },
      "visible-versions": {
        "jira.board-versions": "/board/{boardId}/version",
      },
      "board-issue-estimation": {
        "jira.issue-estimation": "/issue/{issueIdOrKey}/estimation",
      },
      "visible-sprints": {
        "jira.sprint": "/sprint/{sprintId}",
        "jira.sprint-property": "/sprint/{sprintId}/properties/{propertyKey}",
        "jira.sprint-property-keys": "/sprint/{sprintId}/properties",
        "jira.sprints": "/board/{boardId}/sprint",
      },
    },
    "/rest/agile/1.0",
  ),
  ...operations(
    "POST",
    {
      "issue-membership-and-readback": {
        "jira.backlog-move-issues": "/backlog/issue",
        "jira.epic-move-issues": "/epic/{epicIdOrKey}/issue",
        "jira.sprint-move-issues": "/sprint/{sprintId}/issue",
      },
      "board-create-and-readback": {
        "jira.board-create": "/board",
      },
      "epic-removal-and-readback": {
        "jira.epic-remove-issues": "/epic/none/issue",
      },
      "epic-update-and-readback": {
        "jira.epic-update": "/epic/{epicIdOrKey}",
      },
      "sprint-create-and-readback": {
        "jira.sprint-create": "/sprint",
      },
      "sprint-update-and-readback": {
        "jira.sprint-update": "/sprint/{sprintId}",
      },
      "sprint-swap-and-position-uncertainty": {
        "jira.swap-sprints": "/sprint/{sprintId}/swap",
      },
    },
    "/rest/agile/1.0",
  ),
  ...operations(
    "PUT",
    {
      "rank-and-position-uncertainty": {
        "jira.rank-epic": "/epic/{epicIdOrKey}/rank",
        "jira.rank-issues": "/issue/rank",
      },
      "sprint-replace-and-readback": {
        "jira.replace-sprint": "/sprint/{sprintId}",
      },
      "entity-property-and-readback": {
        "jira.set-board-property": "/board/{boardId}/properties/{propertyKey}",
        "jira.set-sprint-property": "/sprint/{sprintId}/properties/{propertyKey}",
      },
      "board-refined-velocity-and-readback": {
        "jira.set-board-refined-velocity": "/board/{boardId}/settings/refined-velocity",
      },
      "issue-estimation-and-readback": {
        "jira.set-issue-estimation": "/issue/{issueIdOrKey}/estimation",
      },
      "instance-admin-sprint-unmap-all-unconfirmed": {
        "jira.unmap-all-sprints": "/sprint/unmap-all",
      },
      "sprint-unmap-and-readback": {
        "jira.unmap-sprints": "/sprint/unmap",
      },
    },
    "/rest/agile/1.0",
  ),
  ...operations(
    "DELETE",
    {
      "board-delete-unconfirmed": {
        "jira.delete-board": "/board/{boardId}",
      },
      "entity-property-and-readback": {
        "jira.delete-board-property": "/board/{boardId}/properties/{propertyKey}",
        "jira.delete-sprint-property": "/sprint/{sprintId}/properties/{propertyKey}",
      },
      "sprint-delete-and-membership-uncertainty": {
        "jira.delete-sprint": "/sprint/{sprintId}",
      },
    },
    "/rest/agile/1.0",
  ),
  ...operations(
    "GET",
    {
      "bound-current-session": {
        "jira.current-session": "/session",
      },
    },
    "/rest/auth/1",
  ),
  ...operations(
    "POST",
    {
      "bound-private-session-and-uncertainty": {
        "jira.login": "/session",
      },
    },
    "/rest/auth/1",
  ),
  ...operations(
    "DELETE",
    {
      "bound-private-session-and-uncertainty": {
        "jira.logout": "/session",
        "jira.release-websudo": "/websudo",
      },
    },
    "/rest/auth/1",
  ),
  "jira.search-post": ["POST", "read", "/search", "visible-issues"],
  "jira.validate-create-user-password": [
    "POST",
    "read",
    "/password/policy/createUser",
    "bound-protected-password-policy",
    "/rest/api/2",
  ],
  "jira.validate-license": [
    "POST",
    "read",
    "/licenseValidator",
    "instance-admin-protected-license-validation",
    "/rest/api/2",
  ],
  "jira.validate-update-user-password": [
    "POST",
    "read",
    "/password/policy/updateUser",
    "bound-protected-password-policy",
    "/rest/api/2",
  ],
  "jira.worklogs-by-id": ["POST", "read", "/worklog/list", "native-visible-requested-worklogs"],
} as const satisfies Readonly<Record<NativeTool, NativeSpecification>>;
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
  // Pages the Chat's Knowledge requirements through the same local staging as jira.draft-stage.
  "jira.draft-batch": { members: ["jira.create-fields"], local: "local-draft" },
  "jira.draft": { members: ["jira.create", "jira.edit"], local: "local-draft" },
};

/**
 * Operations a normal Jira user cannot read, each with its evidence. `jira.custom-fields`: Jira
 * answers the native GET /rest/api/2/customFields with 403 to a normal actor and 200 to an
 * administrator (lab, 2026-11-14). Add an operation only with evidence of the same kind.
 */
const ADMINISTRATION_ONLY: ReadonlySet<string> = new Set(["jira.custom-fields"]);

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
      ...(ADMINISTRATION_ONLY.has(name) ? { administration: true as const } : {}),
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

const OPERATION_DEFINITIONS = deepFreeze([
  ...Object.keys(NATIVE).map(definitionFor),
  ...Object.keys(COMPOSITES).map(definitionFor),
]);

/** Discovery metadata only; selected declarations own schema compilation and contract binding. */
export function jiraOperationDefinitions(): readonly JiraOperationDefinition[] {
  return OPERATION_DEFINITIONS;
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

/** A disjunction root carries only its keyword, annotations and an optional explicit object type. */
function closedDisjunction(schema: CatalogJsonObject, keyword: "anyOf" | "oneOf"): boolean {
  const allowed = new Set(["$schema", "description", "type", keyword]);
  return (
    (schema.type === undefined || schema.type === "object") &&
    Object.keys(schema).every((key) => allowed.has(key))
  );
}

/** One guidance sentence is at most 380 bytes; the schema keeps room for the 1280 bound that follows. */
const JIRA_READ_GUIDANCE_SCHEMA_CHARS = 512;
/**
 * What a failed native read carries to the model (#4357): the outcome and closed reason, Jira's own
 * sanitized messages and the guidance sentence. Each read owns its schema, so the properties it does
 * not declare are added here once; a property it declares keeps its own definition.
 */
const READ_FAILURE_PROPERTIES: CatalogJsonObject = {
  outcome: { type: "string", enum: ["succeeded", "failed"] },
  reason: { type: "string", minLength: 1, maxLength: 64 },
  messages: {
    type: "array",
    maxItems: JIRA_MUTATION_DETAIL_LIMITS.messages,
    items: { type: "string", minLength: 1, maxLength: JIRA_MUTATION_DETAIL_LIMITS.messageChars },
  },
  guidance: { type: "string", minLength: 1, maxLength: JIRA_READ_GUIDANCE_SCHEMA_CHARS },
};
/**
 * `full` for a plain object root. A branch of a disjunction already states its own outcome shape;
 * it receives only the guidance, so a branch can never come to match a shape it did not describe.
 */
type ReadFailureScope = "full" | "guidance" | "none";
export function withReadFailureProperties(
  properties: CatalogJsonObject,
  scope: ReadFailureScope,
): CatalogJsonObject {
  if (scope === "none") return properties;
  const added = Object.entries(READ_FAILURE_PROPERTIES).filter(
    ([name]) => (scope === "full" || name === "guidance") && !Object.hasOwn(properties, name),
  );
  return { ...Object.fromEntries(added), ...properties };
}

function boundObjectSchema(
  schema: CatalogJsonObject,
  kind: "input" | "result",
  read: ReadFailureScope = "none",
): CatalogJsonObject {
  const { properties, required } = schema;
  if (schema.type === "object") {
    if (kind === "input") return schema;
    if (schemaObject(properties) && schemaRequired(required))
      return {
        ...schema,
        properties: {
          ...withReadFailureProperties(properties, read),
          operationBinding: BINDING_SCHEMA,
        },
        required: [...required, "operationBinding"],
      };
  }
  // Every alternative must already be an object. State that common root type for MCP without
  // replacing an explicit type or lifting properties out of their closed branch. Only results
  // receive the operation binding; input alternatives keep their complete original constraints.
  const keyword = schema.anyOf === undefined ? "oneOf" : "anyOf";
  const alternatives = schema[keyword];
  if (
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    !closedDisjunction(schema, keyword)
  )
    throw new ToolCatalogError("invalid-schema");
  return {
    ...schema,
    type: "object",
    [keyword]: alternatives.map((alternative: CatalogJsonValue) => {
      if (!schemaObject(alternative)) throw new ToolCatalogError("invalid-schema");
      return boundObjectSchema(alternative, kind, read === "none" ? "none" : "guidance");
    }),
  };
}

function resultDescriptor(descriptor: ToolDescriptor, read: boolean): ToolDescriptor {
  const { descriptorDigest: _digest, ...original } = descriptor;
  return createToolDescriptor({
    ...original,
    toolRef: createToolRef(descriptor.toolRef.canonicalId, descriptor.toolRef.contractVersion + 1),
    inputSchema: boundObjectSchema(descriptor.inputSchema, "input"),
    resultSchema: boundObjectSchema(descriptor.resultSchema, "result", read ? "full" : "none"),
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
  const projection = resultDescriptor(
    declaration.descriptor,
    definition.kind === "native" && !definition.effects.includes("remote-write"),
  );
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
  humanInputRevision?: string,
): string {
  return sha256Hex(
    canonicalise({
      operation,
      argumentsDigest,
      ...(operationBinding === undefined ? {} : { operationBinding }),
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      ...(humanInputRevision === undefined ? {} : { humanInputRevision }),
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
