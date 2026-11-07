import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
  JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import {
  FIELDS,
  LINKS_FIELD,
  REQUIRED_CUSTOM,
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../../tests/support/jira-managed-remote.js";
import { createJiraProviderForCatalog, jiraOperationContracts } from "./jiraManagedProvider.js";
import {
  observeNativeJiraOperation,
  assertNativeJiraPrimary as assertPrimary,
  type Scenario,
  type Observation,
} from "../../../../tests/support/jira-operation-transport-contract.js";
import { propertyTransportFixture, PROPERTY_FIXTURE_KEY, REVIEWED_PROPERTY_NODES, REQUESTED_PROPERTY_NODES } from "../../../../tests/support/jira-property-transport-fixture.js";

const ISSUE_PARAMETERS = { issueIdOrKey: "SYN-1" };
const PAGING = { startAt: "0", maxResults: "25" };
const CREATE = {
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "After", customfield_10000: "Required" },
};
// Inputs and selected resource identities are independent fixtures, not generated from the registry.
const SCENARIOS: readonly Scenario[] = [
  { tool: "jira.set-comment-property", args: { issueIdOrKey: "SYN-1", commentId: "10002", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { commentId: "10002", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.delete-comment-property", args: { issueIdOrKey: "SYN-1", commentId: "10002", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { commentId: "10002", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.set-dashboard-item-property", args: { dashboardId: "71", itemId: "81", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { dashboardId: "71", itemId: "81", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.delete-dashboard-item-property", args: { dashboardId: "71", itemId: "81", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { dashboardId: "71", itemId: "81", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.set-issue-property", args: { issueIdOrKey: "SYN-1", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { issueIdOrKey: "10001", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.delete-issue-property", args: { issueIdOrKey: "SYN-1", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { issueIdOrKey: "10001", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.set-issue-type-property", args: { issueTypeId: "10001", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { issueTypeId: "10001", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.delete-issue-type-property", args: { issueTypeId: "10001", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { issueTypeId: "10001", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.set-project-property", args: { projectIdOrKey: "SYN", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { projectIdOrKey: "10000", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.delete-project-property", args: { projectIdOrKey: "SYN", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { projectIdOrKey: "10000", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.set-user-property", args: { username: "synthetic-user", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { propertyKey: PROPERTY_FIXTURE_KEY }, query: { userKey: "JIRAUSER10100" } },
  { tool: "jira.delete-user-property", args: { username: "synthetic-user", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { propertyKey: PROPERTY_FIXTURE_KEY }, query: { userKey: "JIRAUSER10100" } },
  { tool: "jira.set-app-monitoring", args: { expectedEnabled: false, enabled: true } },
  { tool: "jira.set-ipd-monitoring", args: { expectedEnabled: true, enabled: false } },
  { tool: "jira.start-jmx-metrics", args: { expectedEnabled: false } },
  { tool: "jira.stop-jmx-metrics", args: { expectedEnabled: true } },
  { tool: "jira.issue-picker", args: { query: "Plan & QA", currentIssueKey: "SYN-1", currentProjectId: "10000", showSubTasks: false, showSubTaskParent: true },
    query: { query: "Plan & QA", currentIssueKey: "SYN-1", currentProjectId: "10000", showSubTasks: "false", showSubTaskParent: "true" }, primaryMethodIndex: 2 },
  { tool: "jira.pinned-comments", args: { issueIdOrKey: "SYN-1", startAt: 0, maxResults: 1 },
    parameters: { issueIdOrKey: "10001" }, primaryMethodIndex: 1 },
  { tool: "jira.subtasks", args: { issueIdOrKey: "SYN-1", startAt: 0, maxResults: 1 },
    parameters: { issueIdOrKey: "10001" }, primaryMethodIndex: 1 },
  { tool: "jira.subtask-move-availability", args: { issueIdOrKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" }, primaryMethodIndex: 1 },
  { tool: "jira.remote-links", args: { issueIdOrKey: "SYN-1", startAt: 0, maxResults: 1 },
    parameters: { issueIdOrKey: "10001" }, primaryMethodIndex: 1 },
  { tool: "jira.remote-link", args: { issueIdOrKey: "SYN-1", linkId: "71" },
    parameters: { issueIdOrKey: "10001", linkId: "71" }, primaryMethodIndex: 1 },
  { tool: "jira.create-screen-tab", args: { screenId: "71", expectedScreenName: "Details & QA", name: "After" },
    parameters: { screenId: "71" } },
  { tool: "jira.rename-screen-tab", args: { screenId: "71", expectedScreenName: "Details & QA", tabId: "81", expectedName: "Details", name: "After" },
    parameters: { screenId: "71", tabId: "81" } },
  { tool: "jira.delete-screen-tab", args: { screenId: "71", expectedScreenName: "Details & QA", tabId: "81", expectedName: "Details", expectedFieldIds: ["summary"] },
    parameters: { screenId: "71", tabId: "81" } },
  { tool: "jira.comment-property-keys", args: { issueIdOrKey: "SYN-1", commentId: "10002" }, parameters: { commentId: "10002" }, primaryMethodIndex: 2 },
  { tool: "jira.comment-property", args: { issueIdOrKey: "SYN-1", commentId: "10002", propertyKey: "view ~settings" },
    parameters: { commentId: "10002", propertyKey: "view ~settings" }, primaryMethodIndex: 2 },
  { tool: "jira.dashboard-item-property-keys", args: { dashboardId: "71", itemId: "81" }, parameters: { dashboardId: "71", itemId: "81" }, primaryMethodIndex: 1 },
  { tool: "jira.dashboard-item-property", args: { dashboardId: "71", itemId: "81", propertyKey: "view ~settings" },
    parameters: { dashboardId: "71", itemId: "81", propertyKey: "view ~settings" }, primaryMethodIndex: 1 },
  { tool: "jira.issue-property-keys", args: { issueIdOrKey: "SYN-1" }, parameters: { issueIdOrKey: "10001" }, primaryMethodIndex: 1 },
  { tool: "jira.issue-property", args: { issueIdOrKey: "SYN-1", propertyKey: "view ~settings" },
    parameters: { issueIdOrKey: "10001", propertyKey: "view ~settings" }, primaryMethodIndex: 1 },
  { tool: "jira.issue-type-property-keys", args: { issueTypeId: "10001" }, parameters: { issueTypeId: "10001" }, primaryMethodIndex: 1 },
  { tool: "jira.issue-type-property", args: { issueTypeId: "10001", propertyKey: "view ~settings" },
    parameters: { issueTypeId: "10001", propertyKey: "view ~settings" }, primaryMethodIndex: 1 },
  { tool: "jira.project-property-keys", args: { projectIdOrKey: "SYN" }, parameters: { projectIdOrKey: "10000" }, primaryMethodIndex: 1 },
  { tool: "jira.project-property", args: { projectIdOrKey: "SYN", propertyKey: "view ~settings" },
    parameters: { projectIdOrKey: "10000", propertyKey: "view ~settings" }, primaryMethodIndex: 1 },
  { tool: "jira.user-property-keys", args: { username: "synthetic-user" }, query: { userKey: "JIRAUSER10100" }, primaryMethodIndex: 1 },
  { tool: "jira.user-property", args: { username: "synthetic-user", propertyKey: "view ~settings" },
    parameters: { propertyKey: "view ~settings" }, query: { userKey: "JIRAUSER10100" }, primaryMethodIndex: 1 },
  { tool: "jira.reindex-status", args: {} },
  { tool: "jira.password-policy", args: { hasOldPassword: true, maxResults: 1 }, query: { hasOldPassword: "true" } },
  { tool: "jira.duplicate-user-count", args: {}, query: { flush: "false" } },
  { tool: "jira.duplicate-users", args: { maxResults: 1 }, query: { flush: "false" } },
  { tool: "jira.search-error", args: {} },
  { tool: "jira.application-properties", args: { key: "jira.option.voting" }, query: { key: "jira.option.voting" } },
  { tool: "jira.advanced-settings", args: { maxResults: 1 } },
  { tool: "jira.my-preference", args: { key: "user.issues.per.page" }, query: { key: "user.issues.per.page" } },
  { tool: "jira.reindex-progress", args: { taskId: "9223372036854775807" }, query: { taskId: "9223372036854775807" } },
  { tool: "jira.reindex-request", args: { requestId: "7" }, parameters: { requestId: "7" } },
  { tool: "jira.reindex-requests", args: { requestIds: ["7"], startAt: 0, maxResults: 1 }, query: { requestId: "7" } },
  { tool: "jira.upgrade-result", args: {} },
  { tool: "jira.index-snapshots", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.app-monitoring", args: {} },
  { tool: "jira.ipd-monitoring", args: {} },
  { tool: "jira.jmx-metrics", args: {} },
  { tool: "jira.global-version-page", args: { startAt: 0, maxResults: 1, query: "Next & later", projectIds: ["10000"] },
    query: { startAt: "0", maxResults: "1", query: "Next & later", projectIds: "10000" } },
  { tool: "jira.component-page", args: { startAt: 0, maxResults: 1, query: "", projectIds: ["10000"] },
    query: { startAt: "0", maxResults: "1", query: "", projectIds: "10000" } },
  { tool: "jira.link-type", args: { linkTypeId: "31" }, parameters: { issueLinkTypeId: "31" } },
  { tool: "jira.accessibility-settings", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.system-columns", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.user-columns", args: { username: "Review + QA", startAt: 0, maxResults: 1 }, query: { username: "Review + QA" } },
  { tool: "jira.filter-columns", args: { filterId: "42", startAt: 0, maxResults: 1 }, parameters: { id: "42" } },
  { tool: "jira.cluster-nodes", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.cluster-upgrade-state", args: {} },
  { tool: "jira.index-snapshot-status", args: {} },
  { tool: "jira.index-summary", args: {} },
  { tool: "jira.jmx-metrics-exposed", args: {} },
  { tool: "jira.search-max-aggregation-buckets", args: {} },
  { tool: "jira.search-max-result-window", args: {} },
  { tool: "jira.screens", args: { startAt: 0, maxResults: 1, search: "Details & QA" }, query: { startAt: "0", maxResults: "1", search: "Details & QA" } },
  { tool: "jira.workflows", args: { workflowName: "Review & QA" }, query: { workflowName: "Review & QA" } },
  { tool: "jira.custom-fields", args: { startAt: 0, maxResults: 1, search: "Delivery" }, query: { startAt: "0", maxResults: "1", search: "Delivery" } },
  { tool: "jira.custom-field-options", args: {
    customFieldId: "10001", page: 2, maxResults: 1, query: "", useAllContexts: false,
    sortByOptionName: true, projectIds: ["10000"], issueTypeIds: ["10001"],
  }, parameters: { customFieldId: "10001" }, query: {
    page: "2", maxResults: "1", query: "", useAllContexts: "false", sortByOptionName: "true", projectIds: "10000", issueTypeIds: "10001",
  } },
  { tool: "jira.terminology", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.terminology-entry", args: { originalName: "epic" }, parameters: { originalName: "epic" } },
  { tool: "jira.read-only-mode", args: {} },
  { tool: "jira.jql-autocomplete", args: { category: "fields", startAt: 0, maxResults: 1 } },
  {
    tool: "jira.jql-suggestions",
    args: { fieldName: "project & team", fieldValue: '"Ac"', predicateName: "from", predicateValue: "Old & new", startAt: 0, maxResults: 1 },
    query: { fieldName: "project & team", fieldValue: '"Ac"', predicateName: "from", predicateValue: "Old & new" },
  },
  {
    tool: "jira.multi-project-assignable-users",
    args: { projectKeys: ["SYN", "OTHER"], query: "Synthetic + QA", maxResults: 1 },
    query: { maxResults: "1", username: "Synthetic + QA", projectKeys: "SYN,OTHER" },
  },
  {
    tool: "jira.permission-users",
    args: { permissions: ["BROWSE_PROJECTS", "ASSIGN_ISSUES"], issueKey: "SYN-1", query: "Synthetic", startAt: 0, maxResults: 1 },
    query: { maxResults: "1", username: "Synthetic", issueKey: "SYN-1", permissions: "BROWSE_PROJECTS,ASSIGN_ISSUES", startAt: "0" },
  },
  {
    tool: "jira.browse-permission-users", args: { projectKey: "SYN", query: "Synthetic", maxResults: 1 },
    query: { maxResults: "1", username: "Synthetic", projectKey: "SYN" },
  },
  {
    tool: "jira.group-user-picker",
    args: { query: "Synthetic", maxResults: 1, fieldId: "customfield_10001", projectId: "9223372036854775807", issueTypeId: "10001" },
    query: { maxResults: "1", query: "Synthetic", showAvatar: "false", fieldId: "customfield_10001", projectId: "9223372036854775807", issueTypeId: "10001" },
  },
  {
    tool: "jira.project-picker", args: { query: "Syn", maxResults: 1, allowEmptyQuery: false },
    query: { maxResults: "1", query: "Syn", allowEmptyQuery: "false" },
  },
  { tool: "jira.fields", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.custom-field-option", args: { optionId: "91" }, parameters: { id: "91" } },
  { tool: "jira.component-related-issue-counts", args: { componentId: "71" }, parameters: { id: "71" } },
  { tool: "jira.version-related-issue-counts", args: { versionId: "81" }, parameters: { id: "81" } },
  { tool: "jira.version-unresolved-issue-count", args: { versionId: "81" }, parameters: { id: "81" } },
  {
    tool: "jira.project-version-page", args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1, orderBy: "+name" },
    parameters: { projectIdOrKey: "10000" }, primaryMethodIndex: 1,
    query: { startAt: "0", maxResults: "1", orderBy: "+name" },
  },
  { tool: "jira.roles", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.role", args: { roleId: "37" }, parameters: { id: "37" } },
  { tool: "jira.role-default-actors", args: { roleId: "37", startAt: 0, maxResults: 1 }, parameters: { id: "37" } },
  {
    tool: "jira.project-roles", args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectIdOrKey: "10000" }, primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-role", args: { projectIdOrKey: "SYN", roleId: "37" },
    parameters: { projectIdOrKey: "10000", id: "37" }, primaryMethodIndex: 1,
  },
  { tool: "jira.priority-schemes", args: { startAt: 0, maxResults: 1 }, query: { startAt: "0", maxResults: "1" } },
  { tool: "jira.priority-scheme", args: { schemeId: "49" }, parameters: { schemeId: "49" } },
  { tool: "jira.server-info", args: {} },
  { tool: "jira.instance-configuration", args: {} },
  { tool: "jira.permission-definitions", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.myself", args: {} },
  { tool: "jira.global-issue-types", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.issue-type", args: { issueTypeId: "10001" }, parameters: { id: "10001" } },
  {
    tool: "jira.issue-type-page",
    args: { startAt: 0, maxResults: 1, query: "Story + QA", projectIds: ["9223372036854775807"] },
    query: { startAt: "0", maxResults: "1", query: "Story + QA", projectIds: "9223372036854775807" },
  },
  {
    tool: "jira.issue-type-alternatives", args: { issueTypeId: "10001", startAt: 0, maxResults: 1 },
    parameters: { id: "10001" },
  },
  { tool: "jira.priorities", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.priority", args: { priorityId: "3" }, parameters: { id: "3" } },
  {
    tool: "jira.priority-page",
    args: { startAt: 0, maxResults: 1, query: "Normal", projectIds: ["10000"] },
    query: { startAt: "0", maxResults: "1", query: "Normal", projectIds: "10000" },
  },
  { tool: "jira.resolutions", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.resolution", args: { resolutionId: "41" }, parameters: { id: "41" } },
  {
    tool: "jira.resolution-page", args: { startAt: 0, maxResults: 1, query: "Fixed" },
    query: { startAt: "0", maxResults: "1", query: "Fixed" },
  },
  { tool: "jira.statuses", args: { startAt: 0, maxResults: 1 } },
  {
    tool: "jira.status", args: { statusIdOrName: "In Progress + QA" },
    parameters: { idOrName: "In Progress + QA" },
  },
  {
    tool: "jira.status-page",
    args: { startAt: 0, maxResults: 1, query: "In Progress", projectIds: ["10000"], issueTypeIds: ["10001"] },
    query: { startAt: "0", maxResults: "1", query: "In Progress", projectIds: "10000", issueTypeIds: "10001" },
  },
  { tool: "jira.status-categories", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.status-category", args: { statusCategoryIdOrKey: "indeterminate" }, parameters: { idOrKey: "indeterminate" } },
  { tool: "jira.project-categories", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.project-category", args: { projectCategoryId: "51" }, parameters: { id: "51" } },
  {
    tool: "jira.project-statuses", args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectIdOrKey: "10000" }, primaryMethodIndex: 1,
  },
  { tool: "jira.project-types", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.project-type-definition", args: { projectTypeKey: "software" }, parameters: { projectTypeKey: "software" } },
  {
    tool: "jira.project-permission-scheme",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-issue-security-scheme",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-security-levels",
    args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-workflow-scheme",
    args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-priority-scheme",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.permission-schemes",
    args: { startAt: 0, maxResults: 1, includePermissions: true },
    query: { expand: "permissions" },
  },
  {
    tool: "jira.permission-scheme",
    args: { schemeId: "37", includePermissions: true },
    parameters: { schemeId: "37" },
    query: { expand: "permissions" },
  },
  {
    tool: "jira.permission-grants",
    args: { schemeId: "37", startAt: 0, maxResults: 1 },
    parameters: { schemeId: "37" },
  },
  {
    tool: "jira.permission-grant",
    args: { schemeId: "37", permissionId: "81" },
    parameters: { schemeId: "37", permissionId: "81" },
  },
  { tool: "jira.issue-security-schemes", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.issue-security-scheme", args: { schemeId: "38" }, parameters: { id: "38" } },
  { tool: "jira.security-level", args: { levelId: "91" }, parameters: { id: "91" } },
  {
    tool: "jira.notification-schemes",
    args: { startAt: 0, maxResults: 1, includeEvents: true },
    query: { startAt: "0", maxResults: "1", expand: "notificationSchemeEvents,user,group,projectRole,field" },
  },
  {
    tool: "jira.notification-scheme",
    args: { schemeId: "47", includeEvents: true },
    parameters: { id: "47" },
    query: { expand: "notificationSchemeEvents,user,group,projectRole,field" },
  },
  {
    tool: "jira.project-notification-scheme",
    args: { projectIdOrKey: "SYN", includeEvents: false },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.user",
    args: { userKey: "JIRAUSER10100", includeDeleted: true },
    query: { key: "JIRAUSER10100", includeDeleted: "true" },
  },
  {
    tool: "jira.users",
    args: {
      query: "Synthetic + QA",
      startAt: 0,
      maxResults: 2,
      includeActive: true,
      includeInactive: false,
    },
    query: {
      username: "Synthetic + QA",
      startAt: "0",
      maxResults: "2",
      includeActive: "true",
      includeInactive: "false",
    },
  },
  {
    tool: "jira.user-directory",
    args: { cursor: "-9223372036854775808", maxResults: 2 },
    query: { cursor: "-9223372036854775808", maxResults: "2" },
  },
  {
    tool: "jira.user-picker",
    args: { query: "Synthetic + QA", maxResults: 2 },
    query: { query: "Synthetic + QA", maxResults: "2", showAvatar: "false" },
  },
  {
    tool: "jira.group-members",
    args: { groupName: "R&D team", startAt: 0, maxResults: 2, includeInactiveUsers: true },
    query: { groupname: "R&D team", startAt: "0", maxResults: "2", includeInactiveUsers: "true" },
  },
  {
    tool: "jira.groups",
    args: { query: "R&D", maxResults: 2 },
    query: { query: "R&D", maxResults: "2" },
  },
  { tool: "jira.application-roles", args: { startAt: 0, maxResults: 2 } },
  {
    tool: "jira.application-role",
    args: { applicationRoleKey: "jira-software" },
    parameters: { key: "jira-software" },
  },
  {
    tool: "jira.workflow-scheme",
    args: { schemeId: "37", returnDraftIfExists: true },
    parameters: { id: "37" },
    query: { returnDraftIfExists: "true" },
  },
  { tool: "jira.workflow-scheme-draft", args: { schemeId: "37" }, parameters: { id: "37" } },
  {
    tool: "jira.workflow-scheme-default",
    args: { schemeId: "37", returnDraftIfExists: false },
    parameters: { id: "37" },
    query: { returnDraftIfExists: "false" },
  },
  {
    tool: "jira.workflow-scheme-draft-default",
    args: { schemeId: "37" },
    parameters: { id: "37" },
  },
  {
    tool: "jira.workflow-scheme-issue-type",
    args: { schemeId: "37", issueTypeId: "1", returnDraftIfExists: true },
    parameters: { id: "37", issueType: "1" },
    query: { returnDraftIfExists: "true" },
  },
  {
    tool: "jira.workflow-scheme-draft-issue-type",
    args: { schemeId: "37", issueTypeId: "1" },
    parameters: { id: "37", issueType: "1" },
  },
  {
    tool: "jira.workflow-scheme-workflows",
    args: { schemeId: "37", returnDraftIfExists: false },
    parameters: { id: "37" },
    query: { returnDraftIfExists: "false" },
  },
  {
    tool: "jira.workflow-scheme-draft-workflows",
    args: { schemeId: "37", workflowName: "In Progress + QA" },
    parameters: { id: "37" },
    query: { workflowName: "In Progress + QA" },
  },
  {
    tool: "jira.issue-type-schemes",
    args: { startAt: 0, maxResults: 1, includeIssueTypes: true, includeDefaultIssueType: true },
    query: { expand: "schemes.issueTypes,schemes.defaultIssueType" },
  },
  { tool: "jira.issue-type-scheme", args: { schemeId: "37" }, parameters: { schemeId: "37" } },
  {
    tool: "jira.issue-type-scheme-projects",
    args: { schemeId: "37", startAt: 0, maxResults: 1 },
    parameters: { schemeId: "37" },
  },
  {
    tool: "jira.screen-tabs",
    args: { screenId: "71", projectKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { screenId: "71" },
    query: { projectKey: "SYN" },
  },
  {
    tool: "jira.screen-tab-fields",
    args: { screenId: "71", tabId: "81", projectKey: "SYN" },
    parameters: { screenId: "71", tabId: "81" },
    query: { projectKey: "SYN" },
  },
  {
    tool: "jira.screen-available-fields",
    args: { screenId: "71" },
    parameters: { screenId: "71" },
  },
  {
    tool: "jira.create-worklog",
    args: {
      issueKey: "SYN-1",
      timeSpentSeconds: 1200,
      started: "2026-11-07T10:00:00Z",
      comment: "Investigated",
    },
    parameters: { issueIdOrKey: "10001" },
    query: { adjustEstimate: "leave" },
  },
  {
    tool: "jira.update-worklog",
    args: { issueKey: "SYN-1", worklogId: "101", comment: "Updated" },
    parameters: { issueIdOrKey: "10001", id: "101" },
    query: { adjustEstimate: "leave" },
  },
  {
    tool: "jira.delete-worklog",
    args: {
      issueKey: "SYN-1",
      worklogId: "101",
      timeSpentSeconds: 3600,
      started: "2026-11-07T09:00:00.000+0000",
      comment: "Original",
      visibility: null,
    },
    parameters: { issueIdOrKey: "10001", id: "101" },
    query: { adjustEstimate: "leave" },
  },
  {
    tool: "jira.watchers",
    args: { issueKey: "SYN-1", startAt: 0, maxResults: 25 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.votes",
    args: { issueKey: "SYN-1", startAt: 0, maxResults: 25 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  { tool: "jira.watch", args: { issueKey: "SYN-1" }, parameters: { issueIdOrKey: "10001" } },
  {
    tool: "jira.unwatch",
    args: { issueKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" },
    query: { username: "synthetic-user" },
  },
  { tool: "jira.vote", args: { issueKey: "SYN-1" }, parameters: { issueIdOrKey: "10001" } },
  { tool: "jira.unvote", args: { issueKey: "SYN-1" }, parameters: { issueIdOrKey: "10001" } },
  { tool: "jira.attachment-settings", args: {} },
  { tool: "jira.attachment", args: { attachmentId: "71" }, parameters: { id: "71" } },
  {
    tool: "jira.delete-attachment",
    args: { issueKey: "SYN-1", attachmentId: "71", filename: "note.txt", size: 14 },
    parameters: { id: "71" },
  },
  {
    tool: "jira.attachment-archive",
    args: { attachmentId: "71", startAt: 0, maxResults: 1 },
    parameters: { id: "71" },
  },
  {
    tool: "jira.attachment-archive-summary",
    args: { attachmentId: "71" },
    parameters: { id: "71" },
  },
  { tool: "jira.system-avatars", args: { avatarType: "user" }, parameters: { type: "user" } },
  {
    tool: "jira.project-avatars",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "SYN" },
  },
  {
    tool: "jira.user-avatars",
    args: { username: "User name+tag" },
    query: { username: "User name+tag" },
  },
  {
    tool: "jira.avatars",
    args: { avatarType: "project", owningObjectId: "10000" },
    parameters: { type: "project", owningObjectId: "10000" },
  },
  { tool: "jira.dashboards", args: { startAt: 0, maxResults: 25 }, query: PAGING },
  { tool: "jira.dashboard", args: { dashboardId: "71" }, parameters: { id: "71" } },
  { tool: "jira.filter-share-scope", args: {} },
  {
    tool: "jira.filter-permissions",
    args: { filterId: "37", startAt: 0, maxResults: 25 },
    parameters: { id: "37" },
  },
  {
    tool: "jira.filter-permission",
    args: { filterId: "37", permissionId: "81" },
    parameters: { id: "37", permissionId: "81" },
  },
  {
    tool: "jira.get-comment",
    args: { issueKey: "SYN-1", commentId: "10002" },
    parameters: { issueIdOrKey: "10001", id: "10002" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.update-comment",
    args: { issueKey: "SYN-1", commentId: "10002", body: "Updated comment" },
    parameters: { issueIdOrKey: "10001", id: "10002" },
  },
  {
    tool: "jira.delete-comment",
    args: { issueKey: "SYN-1", commentId: "10002", expectedBody: "Reviewed comment" },
    parameters: { issueIdOrKey: "10001", id: "10002" },
  },
  { tool: "jira.link-types", args: { startAt: 0, maxResults: 1 } },
  { tool: "jira.issue-link", args: { linkId: "21" }, parameters: { linkId: "21" } },
  {
    tool: "jira.worklogs",
    args: { issueKey: "SYN-1", startAt: 0, maxResults: 25 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.worklog",
    args: { issueKey: "SYN-1", worklogId: "101" },
    parameters: { issueIdOrKey: "10001", id: "101" },
    primaryMethodIndex: 1,
  },
  { tool: "jira.projects", args: {} },
  { tool: "jira.filter", args: { filterId: "37" }, parameters: { id: "37" } },
  { tool: "jira.favourite-filters", args: { startAt: 0, maxResults: 25 } },
  {
    tool: "jira.components",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  { tool: "jira.component", args: { componentId: "71" }, parameters: { id: "71" } },
  {
    tool: "jira.versions",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  { tool: "jira.version", args: { versionId: "81" }, parameters: { id: "81" } },
  { tool: "jira.create-component", args: { projectIdOrKey: "SYN", name: "After" } },
  {
    tool: "jira.update-component",
    args: { componentId: "71", name: "After" },
    parameters: { id: "71" },
  },
  { tool: "jira.create-version", args: { projectId: "10000", name: "After" } },
  {
    tool: "jira.update-version",
    args: { versionId: "81", name: "After" },
    parameters: { id: "81" },
  },
  { tool: "jira.project", args: { projectIdOrKey: "SYN" }, parameters: { projectIdOrKey: "SYN" } },
  { tool: "jira.validate-project-key", args: { key: "SYN" }, query: { key: "SYN" } },
  {
    tool: "jira.project-permissions",
    args: { projectIdOrKey: "10000" },
    query: { projectId: "10000" },
  },
  {
    tool: "jira.project-type",
    args: { projectTypeKey: "software" },
    parameters: { projectTypeKey: "software" },
  },
  {
    tool: "jira.create-project",
    args: { key: "SYN", name: "After", lead: "synthetic-user", projectTypeKey: "software" },
  },
  {
    tool: "jira.update-project",
    args: { projectIdOrKey: "SYN", name: "After" },
    parameters: { projectIdOrKey: "10000" },
  },
  {
    tool: "jira.issue-types",
    args: { projectKey: "SYN" },
    parameters: { projectIdOrKey: "SYN" },
    query: PAGING,
  },
  {
    tool: "jira.create-fields",
    args: { projectKey: "SYN", issueTypeId: "10001", maxResults: 100 },
    parameters: { projectIdOrKey: "SYN", issueTypeId: "10001" },
    query: { ...PAGING, maxResults: "100" },
  },
  { tool: "jira.edit-fields", args: { issueKey: "SYN-1" }, parameters: ISSUE_PARAMETERS },
  {
    tool: "jira.search",
    args: { jql: "project = SYN", maxResults: 50 },
    query: {
      ...PAGING,
      jql: "project = SYN",
      maxResults: "50",
      fields: "summary,status,issuetype,project,assignee,priority,labels,created,updated",
    },
  },
  {
    tool: "jira.issue",
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: {
      fields:
        "summary,description,status,issuetype,project,assignee,reporter,priority,labels,duedate,created,updated",
    },
  },
  {
    tool: "jira.comments",
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: PAGING,
  },
  {
    tool: "jira.transitions",
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: { expand: "transitions.fields" },
  },
  {
    tool: "jira.assignable-users",
    args: { issueKey: "SYN-1", query: "synthetic" },
    query: { ...PAGING, issueKey: "SYN-1", username: "synthetic" },
  },
  { tool: "jira.create", args: CREATE },
  {
    tool: "jira.edit",
    args: { issueKey: "SYN-1", fields: { summary: "After" } },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.assign",
    args: { issueKey: "SYN-1", assigneeName: "synthetic-user" },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.comment",
    args: { issueKey: "SYN-1", body: "Approved comment" },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.transition",
    args: { issueKey: "SYN-1", transitionId: "31", fields: { customfield_10000: "Required" } },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.attach",
    args: { issueKey: "SYN-1", source: { kind: "connected-file", path: "note.txt" } },
    parameters: ISSUE_PARAMETERS,
  },
];
interface RemoteState extends SyntheticJira {
  monitoring: { app: boolean; ipd: boolean; jmx: boolean } | undefined;
  screenTabs: readonly Record<string, unknown>[] | undefined;
  worklog: Record<string, unknown>;
  worklogDeleted: boolean;
  commentDeleted: boolean;
  attachmentDeleted: boolean;
  isWatching: boolean;
  hasVoted: boolean;
  project: Record<string, unknown>;
  component: Record<string, unknown>;
  version: Record<string, unknown>;
}
const MONITORING_WRITES = new Set(["jira.set-app-monitoring", "jira.set-ipd-monitoring", "jira.start-jmx-metrics", "jira.stop-jmx-metrics"]);
function monitoringRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const current = state.monitoring;
  if (current === undefined) return undefined;
  if (path === "monitoring/jmx/areMetricsExposed") return response(current.jmx);
  if (path === "monitoring/app") return response({ enabled: current.app });
  return path === "monitoring/ipd" ? response({ enabled: current.ipd }) : undefined;
}
function monitoringWrite(path: string, request: AtlassianHttpBodyRequest, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const current = state.monitoring;
  if (current === undefined || !path.startsWith("monitoring/")) return undefined;
  expect(request.method).toBe("POST");
  if (path === "monitoring/app" || path === "monitoring/ipd") {
    const enabled = path === "monitoring/app";
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ enabled });
    current[enabled ? "app" : "ipd"] = enabled;
  } else {
    expect(new Set(["monitoring/jmx/startExposing", "monitoring/jmx/stopExposing"]).has(path)).toBe(true);
    expect(request.bodyJson).toBeUndefined();
    current.jmx = path === "monitoring/jmx/startExposing";
  }
  return response({}, 204);
}
const SCREEN_TAB_WRITES = new Set(["jira.create-screen-tab", "jira.rename-screen-tab", "jira.delete-screen-tab"]);
function screenTabRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  return state.screenTabs !== undefined && path === "screens/71/tabs" ? response(state.screenTabs) : undefined;
}
function screenTabWrite(path: string, request: AtlassianHttpBodyRequest, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const tabs = state.screenTabs;
  if (tabs === undefined) return undefined;
  if (path === "screens/71/tabs" && request.method === "POST") {
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ name: "After" });
    state.screenTabs = [...tabs, { id: 83, name: "After" }];
    return response({ id: 83, name: "After" }, 201);
  }
  if (path !== "screens/71/tabs/81") return undefined;
  if (request.method === "PUT") {
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ name: "After" });
    state.screenTabs = tabs.map((tab) => tab.id === 81 ? { ...tab, name: "After" } : tab);
    return response(undefined, 204);
  }
  if (request.method !== "DELETE") return undefined;
  expect(request.bodyJson).toBeUndefined();
  state.screenTabs = tabs.filter((tab) => tab.id !== 81);
  return response(undefined, 204);
}
function collaborationRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const type = { id: "11", name: "Relates", inward: "relates to", outward: "relates to" };
  const worklog = state.worklog;
  if (path === `issue/10001/worklog/${String(worklog.id)}`)
    return state.worklogDeleted ? response({}, 404) : response(worklog);
  if (path === "issue/10001/comment/10002" && state.commentDeleted) return response({}, 404);
  const comment = {
    id: "10002",
    body: state.comment,
    self: "https://jira.example.invalid/context/rest/api/2/issue/10001/comment/10002",
  };
  const comments = state.commentDeleted ? [] : [comment];
  const worklogs = state.worklogDeleted ? [] : [worklog];
  const bodies: Readonly<Record<string, unknown>> = {
    "issue/10001/comment/10002": comment,
    "issue/10001/comment": { startAt: 0, maxResults: 1, total: comments.length, comments },
    issueLinkType: { issueLinkTypes: [type] },
    "issueLink/21": {
      id: "21",
      type,
      inwardIssue: { key: "SYN-1" },
      outwardIssue: { key: "SYN-2" },
    },
    "issue/10001/worklog": { startAt: 0, maxResults: 1, total: worklogs.length, worklogs },
    "issue/10001/worklog/101": worklog,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function collaborationWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path !== "issue/10001/comment/10002") return undefined;
  if (request.method === "DELETE") {
    state.commentDeleted = true;
    return response(undefined, 204);
  }
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  if (request.method !== "PUT" || typeof body.body !== "string")
    throw new TypeError("Expected the selected comment update");
  state.comment = body.body;
  return response({ id: "10002", body: state.comment });
}
function worklogWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path !== "issue/10001/worklog" && path !== "issue/10001/worklog/101") return undefined;
  if (request.method === "DELETE") {
    expect(path).toBe("issue/10001/worklog/101");
    state.worklogDeleted = true;
    return response(undefined, 204);
  }
  const create = path.endsWith("/worklog");
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  state.worklog = {
    ...(create ? {} : state.worklog),
    ...body,
    id: create ? "102" : "101",
    issueId: "10001",
  };
  return response(state.worklog, create ? 201 : 200);
}
function participationRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const person = { name: "synthetic-user", active: true };
  if (path === "myself") return response(person);
  if (path === "issue/10001/watchers")
    return response({
      isWatching: state.isWatching,
      watchCount: state.isWatching ? 1 : 0,
      watchers: state.isWatching ? [person] : [],
    });
  if (path === "issue/10001/votes")
    return response({
      hasVoted: state.hasVoted,
      votes: state.hasVoted ? 1 : 0,
      voters: state.hasVoted ? [person] : [],
    });
  return undefined;
}
function participationWrite(
  path: string,
  method: string,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path === "issue/10001/watchers") state.isWatching = method === "POST";
  else if (path === "issue/10001/votes") state.hasVoted = method === "POST";
  else return undefined;
  return response(undefined, 204);
}
function structureRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "component/71") return response(state.component);
  if (path === "version/81") return response(state.version);
  if (path === "project/10000/components") return response([state.component]);
  if (path === "project/10000/versions") return response([state.version]);
  return releaseRead(path);
}
function releaseRead(path: string): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    "component/71/relatedIssueCounts": { issueCount: 0 },
    "version/81/relatedIssueCounts": {
      issuesAffectedCount: 8, issuesFixedCount: 4, issueCountWithCustomFieldsShowingVersion: 2,
      customFieldNames: [
        { customFieldId: 10001, fieldName: "Delivery", issueCountWithVersionInCustomField: 0 },
        { customFieldId: "9223372036854775807", fieldName: "Audit" },
      ],
    },
    "version/81/unresolvedIssueCount": { issuesUnresolvedCount: 0 },
    "project/10000/version": {
      startAt: 0, maxResults: 1, isLast: false,
      values: [{ id: "81", projectId: 10000, name: "Release", released: false, archived: false, releaseDate: "2026-11-07" }],
    },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function structureWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  if (path === "component" || path === "component/71") {
    state.component = { ...state.component, ...body };
    return response(state.component, request.method === "POST" ? 201 : 200);
  }
  if (path === "version" || path === "version/81") {
    state.version = { ...state.version, ...body };
    return response(state.version, request.method === "POST" ? 201 : 200);
  }
  return undefined;
}
function projectRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "project") return response([state.project]);
  if (path === "project/SYN" || path === "project/10000") return response(state.project);
  if (path === "projectvalidate/key") return response({ errors: {}, errorMessages: [] });
  if (path === "mypermissions")
    return response({ permissions: { ADMINISTER: { havePermission: true } } });
  if (path === "project/type/software/accessible")
    return response({ key: "software", formattedKey: "Software" });
  return undefined;
}
function filterRead(path: string): AtlassianHttpBodyResult | undefined {
  const filter = {
    id: "37",
    name: "Scoped",
    jql: "project=SYN",
    owner: { name: "synthetic-user" },
    sharePermissions: [],
  };
  if (path === "filter/37") return response(filter);
  if (path === "filter/favourite") return response([filter]);
  return undefined;
}
function savedViewRead(path: string): AtlassianHttpBodyResult | undefined {
  const dashboard = { id: "71", name: "Delivery" };
  const permission = { id: 81, type: "group", group: { name: "delivery" }, view: true };
  const bodies: Readonly<Record<string, unknown>> = {
    dashboard: { startAt: 0, maxResults: 25, total: 1, dashboards: [dashboard] },
    "dashboard/71": dashboard,
    "filter/defaultShareScope": { scope: "PRIVATE" },
    "filter/37/permission": [permission],
    "filter/37/permission/81": permission,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function assetRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "attachment/71" && state.attachmentDeleted) return response({}, 404);
  const avatars = { system: [{ id: "91", selected: true }], custom: [] };
  const bodies: Readonly<Record<string, unknown>> = {
    "attachment/71": { id: "71", filename: "note.txt", size: 14, mimeType: "text/plain" },
    "attachment/71/expand/raw": {
      totalEntryCount: 1,
      entries: [{ entryIndex: 0, name: "note.txt", size: 14, mediaType: "text/plain" }],
    },
    "attachment/71/expand/human": {
      id: 71,
      name: "notes.zip",
      mediaType: "application/zip",
      totalEntryCount: 1,
    },
    "avatar/user/system": avatars,
    "project/SYN/avatars": avatars,
    "user/avatars": avatars,
    "universal_avatar/type/project/owner/10000": avatars,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function assetWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path !== "attachment/71" || request.method !== "DELETE") return undefined;
  state.attachmentDeleted = true;
  state.fields.attachment = [];
  return response(undefined, 204);
}
function administrationRead(
  path: string,
  absoluteUrl: string,
): AtlassianHttpBodyResult | undefined {
  const directory = directoryRead(path) ?? accessRead(path) ?? coreMetadataRead(path) ?? instanceRead(path) ?? roleRead(path) ?? configurationRead(path, absoluteUrl) ?? viewConfigurationRead(path);
  if (directory !== undefined) return directory;
  const type = { id: "1", name: "Task", subtask: false };
  const scheme = { id: "37", name: "Delivery", issueTypes: [type], defaultIssueType: type };
  const workflowScheme = {
    id: 37,
    name: "Delivery",
    draft: false,
    defaultWorkflow: "Default",
    issueTypeMappings: { "1": "In Progress + QA" },
  };
  const workflow = { workflow: "In Progress + QA", issueTypes: ["1"], defaultMapping: false };
  const bodies: Readonly<Record<string, unknown>> = {
    issuetypescheme: { schemes: [scheme] },
    "issuetypescheme/37": scheme,
    "issuetypescheme/37/associations": [
      { id: "10000", key: "SYN", name: "Delivery", archived: false },
    ],
    "workflowscheme/37": workflowScheme,
    "workflowscheme/37/draft": { ...workflowScheme, id: 38, draft: true },
    "workflowscheme/37/default": { workflow: "Default" },
    "workflowscheme/37/draft/default": { workflow: "Default Draft" },
    "workflowscheme/37/issuetype/1": { issueType: "1", workflow: "In Progress + QA" },
    "workflowscheme/37/draft/issuetype/1": { issueType: "1", workflow: "In Progress + QA" },
    "workflowscheme/37/workflow": [workflow],
    "workflowscheme/37/draft/workflow": new URL(absoluteUrl).searchParams.has("workflowName")
      ? workflow
      : [workflow],
    "screens/71/tabs": [{ id: 81, name: "Details" }],
    "screens/71/tabs/81/fields": [{ id: "summary", name: "Summary", showWhenEmpty: false }],
    "screens/71/availableFields": [{ id: "description", name: "Description" }],
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function configurationRead(path: string, absoluteUrl: string): AtlassianHttpBodyResult | undefined {
  const workflow = { name: "Review & QA", description: "Native workflow", steps: 0, isDefault: false, lastModifiedDate: "07/Nov/26" };
  const terminology = { originalName: "Epic", originalNamePlural: "Epics", newName: "Initiative", newNamePlural: "Initiatives", isDefault: false };
  const bodies: Readonly<Record<string, unknown>> = {
    screens: { screens: [{ id: 71, name: "Details & QA", deletable: false }], startAt: 0, maxResults: 1, total: 1 },
    workflow: new URL(absoluteUrl).searchParams.has("workflowName") ? workflow : [workflow],
    customFields: { values: [{ id: "customfield_10001", numericId: 10001, name: "Delivery", isLocked: false, projectIds: [], issuesWithValue: 0 }], startAt: 0, maxResults: 1, total: 1 },
    "customFields/10001/options": { options: [{ id: 91, value: "", disabled: false, childrenIds: [] }], total: 3 },
    "terminology/entries": [terminology, { originalName: "Sprint", isDefault: true }],
    "terminology/entries/epic": terminology,
    "readonly-mode": { enabled: false, message: "", endTime: "07/Nov/26 21:30", timeZone: "Europe/Berlin" },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function viewConfigurationRead(path: string): AtlassianHttpBodyResult | undefined {
  const columns = [{ value: "summary", label: "Summary" }, { value: "status", label: "Status" }];
  const bodies: Readonly<Record<string, unknown>> = {
    version: { startAt: 0, maxResults: 1, isLast: false, values: [{ id: "81", name: "Next release", projectId: 10000, released: false }] },
    "component/page": { startAt: 0, maxResults: 1, isLast: false, values: [{ id: "71", name: "Delivery module", project: "SYN", projectId: 10000, deleted: false }] },
    "issueLinkType/31": { id: "31", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    "user/a11y/personal-settings": [{ key: "underline-links", enabled: false }, { key: "keyboard-settings" }],
    "settings/columns": columns,
    "user/columns": columns,
    "filter/42/columns": { columnConfig: "EXPLICIT", columnLayoutItems: [
      { id: "summary", position: -1, columnHeadingKey: "native.summary" }, { id: "summary", position: 1 },
    ] },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function directoryRead(path: string): AtlassianHttpBodyResult | undefined {
  const user = {
    key: "JIRAUSER10100",
    name: "Synthetic-User",
    displayName: "Synthetic User",
    active: false,
    deleted: false,
    emailAddress: "private@example.invalid",
    self: "https://untrusted.invalid/user",
  };
  const role = {
    key: "jira-software",
    name: "Jira Software",
    groups: ["R&D team"],
    defaultGroups: [],
    hasUnlimitedSeats: true,
    numberOfSeats: -1,
    remainingSeats: -7,
    userCount: 12,
  };
  const bodies: Readonly<Record<string, unknown>> = {
    user,
    "user/search": [user],
    "user/list": {
      values: [user],
      maxResults: 2,
      isLast: false,
      nextCursor: "9223372036854775807",
    },
    "user/picker": { users: [user], total: 3, header: "Untrusted header", html: "<b>ignored</b>" },
    "group/member": { values: [user], startAt: 0, maxResults: 2, total: 1, isLast: true },
    "groups/picker": { groups: [{ name: "R&D team", html: "<b>ignored</b>" }], total: 2 },
    applicationrole: [role],
    "applicationrole/jira-software": role,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : scopedDirectoryRead(path, user);
}
function scopedDirectoryRead(path: string, user: Readonly<Record<string, unknown>>): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    "user/assignable/multiProjectSearch": [user],
    "user/permission/search": [user],
    "user/viewissue/search": [user],
    groupuserpicker: { users: { users: [user], total: 3 }, groups: { groups: [], total: 0 } },
    "projects/picker": { projects: [{ id: "10000", key: "SYN", name: "Synthetic" }], total: 2 },
    field: [{ id: "customfield_10001", name: "Delivery", custom: true, searchable: false, clauseNames: ["cf[10001]", "Delivery"],
      schema: { type: "array", items: "string", custom: "synthetic:metadata", customId: 10001 } }],
    "customFieldOption/91": { id: 91, value: "", disabled: false, childrenIds: [] },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function roleRead(path: string): AtlassianHttpBodyResult | undefined {
  const actor = { id: 71, name: "review-team", displayName: "Review team", type: "atlassian-group-role-actor" };
  const role = { id: 37, name: "Reviewers", description: "Configured reviewers", actors: [actor] };
  const scheme = { id: 49, name: "Priorities", defaultScheme: false, defaultOptionId: "3", optionIds: ["1", "3"] };
  const bodies: Readonly<Record<string, unknown>> = {
    role: [role], "role/37": role, "role/37/actors": { actors: [actor] },
    "project/10000/role": { Reviewers: "https://untrusted.invalid/project/10000/role/37" },
    "project/10000/role/37": role,
    priorityschemes: { schemes: [scheme], startAt: 0, maxResults: 1, total: 2 },
    "priorityschemes/49": scheme,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function instanceRead(path: string): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    "cluster/nodes": [{ nodeId: "node-A", state: "PASSIVE", alive: false, nodeBuildNumber: 0,
      lastStateChangeTimestamp: 0, ip: "192.0.2.10", cacheListenerPort: 40001 }],
    "cluster/zdu/state": { state: "READY_TO_UPGRADE", build: { buildNumber: 0, version: "11.3.0" } },
    "index-snapshot/isRunning": { running: false },
    "index/summary": { nodeId: "node-A", reportTime: "2026-11-07T22:00:00+01:00",
      issueIndex: { indexReadable: false, countInIndex: 0 },
      replicationQueues: {}, externalPlatformIndexReplay: { "node-B": {
        queueSize: 0, lastConsumedOperation: { id: -1, journalWriteTime: "Journal at 21:00" },
      } },
    },
    "monitoring/jmx/areMetricsExposed": false,
    "searchLimits/maxAggregationBuckets": 0,
    "searchLimits/maxResultWindow": -1,
    serverInfo: {
      version: "11.3.13", versionNumbers: [11, 3, 13], deploymentType: "Data Center",
      serverTitle: "Synthetic Jira", buildNumber: 11030013, databaseBuildNumber: "9007199254740993",
    },
    configuration: {
      attachmentsEnabled: true, watchingEnabled: false, votingEnabled: true,
      timeTrackingConfiguration: { workingHoursPerDay: 0, workingDaysPerWeek: 4.5, defaultUnit: "hour" },
    },
    permissions: { permissions: {
      EDIT_ISSUE: { id: "12", key: "EDIT_ISSUES", name: "Edit issues", type: "PROJECT", havePermission: true },
    } },
    myself: { key: "U1", name: "Synthetic", displayName: "Synthetic User", active: true },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function jobObservationRead(path: string): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    reindex: { currentProgress: 0, success: false, type: "BACKGROUND" },
    "reindex/progress": { currentProgress: -1, currentSubTask: "Native step", success: false },
    "reindex/request/7": { id: 7, status: "COMPLETE", type: "BACKGROUND" },
    "reindex/request/bulk": [{ id: 7, status: "PENDING" }],
    upgrade: { outcome: "FAILED", duration: 0, message: "Synthetic upgrade result" },
    "index-snapshot": [{ absolutePath: "/server/snapshots/synthetic.zip", timestamp: 0 }],
    "monitoring/app": { enabled: false },
    "monitoring/ipd": {},
    "monitoring/jmx/getAvailableMetrics": "metric.one\nmetric.two",
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function accountDiagnosticRead(path: string): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    "application-properties": { key: "jira.option.voting", value: "false", example: "discarded" },
    "application-properties/advanced-settings": [{ key: "jira.clone.prefix", value: "" }],
    mypreferences: "0",
    "password/policy": ["Use at least eight characters."],
    "user/duplicated/count": { count: 0 },
    "user/duplicated/list": { sample: [{ directoryId: "9223372036854775807", directoryName: "Local directory", userActive: false }] },
    "search/error/lookup": { errorStringI18n: "The query could not be evaluated." },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function entityPropertyRead(path: string): AtlassianHttpBodyResult | undefined {
  const roots = new Set([
    "comment/10002/properties", "dashboard/71/items/81/properties", "issue/10001/properties",
    "issuetype/10001/properties", "project/10000/properties", "user/properties",
  ]);
  if (roots.has(path)) return response({ keys: [
    { key: "view ~settings", self: "https://untrusted.invalid/property" }, { key: "a/b%" },
  ] });
  const selected = "/view%20~settings";
  return path.endsWith(selected) && roots.has(path.slice(0, -selected.length))
    ? response({ key: "view ~settings", value: { "a/b~c": [null, {}, [], false, 0, ""] } }) : undefined;
}
function coreMetadataRead(path: string): AtlassianHttpBodyResult | undefined {
  const type = { id: "10001", name: "Story", description: "Story metadata", subtask: false, avatarId: 71 };
  const priority = { id: "3", name: "Normal", statusColor: "#123456" };
  const resolution = { id: "41", name: "Fixed", description: "Resolution metadata" };
  const category = { id: 4, key: "indeterminate", name: "In progress", colorName: "yellow" };
  const status = { id: "5", name: "In Progress + QA", statusCategory: category };
  const projectCategory = { id: "51", name: "Engineering" };
  const projectType = { key: "software", formattedKey: "Software", descriptionI18nKey: "project.type.software.description" };
  const page = (item: unknown): Record<string, unknown> => ({
    values: [item], startAt: 0, maxResults: 1, isLast: false,
  });
  const bodies: Readonly<Record<string, unknown>> = {
    issuetype: [type], "issuetype/10001": type, "issuetype/page": page(type),
    "jql/autocompletedata": {
      visibleFieldNames: [{ value: "assignee", auto: "true", orderable: "false", operators: ["=", "was in"], types: ["User"], displayName: "<b>Assignee</b>" }],
      visibleFunctionNames: [{ value: "currentUser()", types: ["User"] }], jqlReservedWords: ["empty"],
    },
    "jql/autocompletedata/suggestions": { results: [{ value: "Atlassian Connect", displayName: "<b>AC</b> Connect" }] },
    "issuetype/10001/alternatives": [{ id: "10002", name: "Task", subtask: false }],
    priority: [priority], "priority/3": priority, "priority/page": page(priority),
    resolution: [resolution], "resolution/41": resolution, "resolution/page": page(resolution),
    status: [status], "status/In%20Progress%20%2B%20QA": status, "status/page": page(status),
    statuscategory: [category], "statuscategory/indeterminate": category,
    projectCategory: [projectCategory], "projectCategory/51": projectCategory,
    "project/10000/statuses": [{ id: "10001", name: "Story", subtask: false, statuses: [status] }],
    "project/type": [projectType], "project/type/software": projectType,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function accessRead(path: string): AtlassianHttpBodyResult | undefined {
  const grant = { id: 81, permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "Developers" } };
  const permissionScheme = { id: 37, name: "Engineering access", permissions: [grant] };
  const level = { id: 91, name: "Restricted", description: "Configured level" };
  const securityScheme = { id: 38, name: "Engineering security", defaultSecurityLevelId: 91, levels: [level] };
  const notificationScheme = {
    id: 47, name: "Notifications", notificationSchemeEvents: [{
      event: { id: 1, name: "Issue updated", templateEvent: { id: 2, name: "Template" } },
      notifications: [{ id: 61, notificationType: "CurrentAssignee" }],
    }],
  };
  const bodies: Readonly<Record<string, unknown>> = {
    permissionscheme: { permissionSchemes: [permissionScheme] },
    "permissionscheme/37": permissionScheme,
    "permissionscheme/37/permission": { permissions: [grant] },
    "permissionscheme/37/permission/81": grant,
    issuesecurityschemes: { issueSecuritySchemes: [securityScheme] },
    "issuesecurityschemes/38": securityScheme,
    "securitylevel/91": level,
    notificationscheme: { startAt: 0, maxResults: 1, total: 2, isLast: false, values: [notificationScheme] },
    "notificationscheme/47": notificationScheme,
    "project/10000/notificationscheme": notificationScheme,
    "project/10000/permissionscheme": permissionScheme,
    "project/10000/issuesecuritylevelscheme": securityScheme,
    "project/10000/securitylevel": { levels: [level] },
    "project/10000/workflowscheme": {
      id: 48, name: "Project workflow", draft: false, defaultWorkflow: "Default workflow",
      issueTypeMappings: { "10001": "Story workflow", "10002": "Task workflow" },
      originalIssueTypeMappings: { "10001": "Original story workflow" },
    },
    "project/10000/priorityscheme": {
      id: 49, name: "Project priorities", defaultScheme: false,
      defaultOptionId: "3", optionIds: ["1", "3"],
    },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function issueMetadata(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  // The resolved numeric identity reads the same existing issue fixture, including current members.
  if (path === "issue/10001") return fixtureRead("/issue/SYN-1", state);
  if (path.endsWith("/issuetypes"))
    return response({
      values: [{ id: "10001", name: "Story", subtask: false }],
      start: 0,
      size: 1,
      last: true,
      total: 1,
    });
  if (path.includes("createmeta"))
    return response({
      values: [...FIELDS, LINKS_FIELD],
      start: 0,
      size: 100,
      last: true,
      total: FIELDS.length + 1,
    });
  if (path.endsWith("/transitions"))
    return response({
      transitions: [
        {
          id: "31",
          name: "Done",
          to: { id: "3", name: "Done" },
          fields: { customfield_10000: REQUIRED_CUSTOM },
        },
      ],
    });
  if (path === "user/assignable/search")
    return response([{ name: "synthetic-user", displayName: "Synthetic", active: true }]);
  if (path === "issue/SYN-1/comment")
    return response({ comments: [], startAt: 0, maxResults: 25, total: 0 });
  return undefined;
}
function issueContextRead(path: string, absoluteUrl: string): AtlassianHttpBodyResult | undefined {
  const link = { id: 71, globalId: "app=synthetic&id=1", application: { type: "synthetic", name: "Reference app" },
    relationship: "references", self: "https://jira.example.invalid/context/rest/api/2/issue/10001/remotelink/71",
    object: { title: "Remote reference", summary: "Plain remote description", url: "https://untrusted.invalid/target", status: { resolved: false } } };
  if (path === "issue/10001/remotelink")
    return response(new URL(absoluteUrl).searchParams.has("globalId") ? link : [link]);
  const bodies: Readonly<Record<string, unknown>> = {
    "issue/picker": { sections: [{ id: "history", label: "Recent issues", issues: [{ key: "SYN-2", summaryText: "Plain suggestion", summary: "<b>Discarded HTML</b>" }] }] },
    "issue/10001/pinned-comments": [{ comment: { id: "10002", body: "Pinned native text", created: "2026-11-07T09:00:00.000+0000",
      author: { name: "synthetic-user", displayName: "Synthetic author" }, self: "https://jira.example.invalid/context/rest/api/2/issue/10001/comment/10002" },
      pinnedBy: "synthetic-user", pinnedDate: "2026-11-07T10:00:00.000+0000" }],
    "issue/10001/subtask": [{ id: "10002", key: "SYN-2", fields: { summary: "Observed subtask", status: { name: "Open" }, parent: { id: "10001", key: "SYN-1" } } }],
    "issue/10001/subtask/move": false,
    "issue/10001/remotelink/71": link,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function projectWrite(
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult {
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  state.project = {
    ...state.project,
    ...body,
    ...(typeof body.lead === "string" ? { lead: { name: body.lead } } : {}),
  };
  return request.method === "POST"
    ? response({ id: 10000, key: "SYN" }, 201)
    : response(state.project);
}
function remoteRead(
  path: string,
  absolute: string,
  state: RemoteState,
  absoluteUrl: string,
): AtlassianHttpBodyResult {
  return (
    monitoringRead(path, state) ??
    screenTabRead(path, state) ??
    projectRead(path, state) ??
    structureRead(path, state) ??
    collaborationRead(path, state) ??
    participationRead(path, state) ??
    filterRead(path) ??
    savedViewRead(path) ??
    assetRead(path, state) ??
    administrationRead(path, absoluteUrl) ??
    jobObservationRead(path) ??
    accountDiagnosticRead(path) ??
    entityPropertyRead(path) ??
    issueContextRead(path, absoluteUrl) ??
    issueMetadata(path, state) ??
    fixtureRead(absolute, state)
  );
}
const PROPERTY_WRITE_ROOTS: Readonly<Record<string, string>> = {
  "jira.set-comment-property": "comment/10002/properties", "jira.delete-comment-property": "comment/10002/properties",
  "jira.set-dashboard-item-property": "dashboard/71/items/81/properties", "jira.delete-dashboard-item-property": "dashboard/71/items/81/properties",
  "jira.set-issue-property": "issue/10001/properties", "jira.delete-issue-property": "issue/10001/properties",
  "jira.set-issue-type-property": "issuetype/10001/properties", "jira.delete-issue-type-property": "issuetype/10001/properties",
  "jira.set-project-property": "project/10000/properties", "jira.delete-project-property": "project/10000/properties",
  "jira.set-user-property": "user/properties", "jira.delete-user-property": "user/properties",
};
function remote(tool?: string, initiallyPresent = true): ReturnType<typeof vi.fn<AtlassianHttpBodyPort>> {
  const propertyRoot = PROPERTY_WRITE_ROOTS[tool ?? ""];
  const property = propertyTransportFixture(propertyRoot === undefined ? undefined : `/context/rest/api/2/${propertyRoot}`, initiallyPresent);
  const state: RemoteState = {
    monitoring: MONITORING_WRITES.has(tool ?? "") ? { app: false, ipd: true, jmx: tool === "jira.stop-jmx-metrics" } : undefined,
    screenTabs: SCREEN_TAB_WRITES.has(tool ?? "") ? [{ id: 81, name: "Details" }, { id: 82, name: "Other" }] : undefined,
    fields: {
      summary: "Before",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: [],
      issuelinks: [],
      attachment:
        tool === "jira.delete-attachment"
          ? [{ id: "71", filename: "note.txt", size: 14 }]
          : [],
    },
    comment: tool === "jira.delete-comment" ? "Reviewed comment" : "",
    commentDeleted: false,
    worklogDeleted: false,
    attachmentDeleted: false,
    worklog: {
      id: "101",
      issueId: "10001",
      timeSpentSeconds: 3600,
      started: "2026-11-07T09:00:00.000+0000",
      comment: "Original",
    },
    isWatching: tool === "jira.unwatch",
    hasVoted: tool === "jira.unvote",
    component: { id: "71", project: "SYN", name: "Before" },
    version: { id: "81", projectId: 10000, name: "Before" },
    project: {
      id: "10000",
      key: "SYN",
      name: "Before",
      lead: { name: "synthetic-user" },
      projectTypeKey: "software",
    },
  };
  return vi.fn<AtlassianHttpBodyPort>((request) => {
    const absolute = new URL(request.url).pathname;
    const path = absolute.replace("/context/rest/api/2/", "");
    if (request.method === "GET")
      return Promise.resolve(property.read(request) ?? remoteRead(path, absolute, state, request.url));
    return Promise.resolve(
      property.write(request) ?? (path === "project" || path === "project/10000"
        ? projectWrite(request, state)
        : (monitoringWrite(path, request, state) ??
            screenTabWrite(path, request, state) ??
            participationWrite(path, request.method, state) ??
            assetWrite(path, request, state) ??
            worklogWrite(path, request, state) ??
            collaborationWrite(path, request, state) ??
            structureWrite(path, request, state) ??
            fixtureWrite(absolute, request.bodyJson, state, request.upload))),
    );
  });
}
function connection(http: AtlassianHttpBodyPort): JiraManagedConnection {
  const bytes = new TextEncoder().encode("Governed attachment fixture");
  return {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    http,
    attachmentSource: () =>
      Promise.resolve({
        ok: true,
        content: {
          name: "note.txt",
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
  };
}
function observe(scenario: Scenario): Promise<Observation> {
  return observeNativeJiraOperation(scenario, connection(remote(scenario.tool)));
}

describe("native Jira registry and real connector transport agreement", () => {
  it("covers every current platform native operation exactly once", () => {
    const platformRoots = new Set(["/rest/api/2"]);
    const native = jiraOperationContracts().filter(
      ({ definition }) => definition.kind === "native" && platformRoots.has(definition.apiRoot),
    );
    expect(native).toHaveLength(216);
    expect(SCENARIOS).toHaveLength(native.length);
    expect(new Set(SCENARIOS.map(({ tool }) => tool))).toEqual(
      new Set(native.map(({ definition }) => definition.tool)),
    );
  });
  it.each(SCENARIOS)("binds $tool to its actual primary HTTP request", async (scenario) => {
    const observed = await observe(scenario);
    assertPrimary(observed, scenario);
    const writes = observed.requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(observed.definition.method === "GET" ? 0 : 1);
  });
  it.each(["jira.set-issue-property", "jira.delete-issue-property"] as const)(
    "rebinds the canonical parent and reads keys/value after exactly one %s effect", async (tool) => {
      const scenario = SCENARIOS.find((entry) => entry.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing property write fixture");
      const observed = await observe(scenario);
      const requests = observed.requests.map(({ method, url }) => [method, new URL(url).pathname]);
      const property = "/context/rest/api/2/issue/10001/properties";
      expect(requests).toEqual([
        ["GET", "/context/rest/api/2/issue/SYN-1"], ["GET", property], ["GET", `${property}/view%20~settings`],
        [tool === "jira.set-issue-property" ? "PUT" : "DELETE", `${property}/view%20~settings`],
        ["GET", "/context/rest/api/2/issue/10001"], ["GET", property], ["GET", `${property}/view%20~settings`],
      ]);
      expect(observed.result.data).toMatchObject({ issueId: "10001", issueKey: "SYN-1", propertyKey: PROPERTY_FIXTURE_KEY, propertyPresent: tool === "jira.set-issue-property" });
      const write = observed.requests.find(({ method }) => method !== "GET");
      expect(write?.bodyJson).toBe(tool === "jira.set-issue-property" ? "false" : undefined);
    },
  );
  it("sends JSON null as a literal value after independently reviewed absence", async () => {
    const scenario: Scenario = { tool: "jira.set-user-property", args: { username: "synthetic-user", propertyKey: PROPERTY_FIXTURE_KEY,
      expectAbsent: true, valueNodes: REVIEWED_PROPERTY_NODES }, parameters: { propertyKey: PROPERTY_FIXTURE_KEY }, query: { userKey: "JIRAUSER10100" } };
    const observed = await observeNativeJiraOperation(scenario, connection(remote(scenario.tool, false)));
    assertPrimary(observed, scenario);
    expect(observed.requests.find(({ method }) => method === "PUT")?.bodyJson).toBe("null");
    expect(observed.result.data).toMatchObject({ userKey: "JIRAUSER10100", username: "Synthetic-User", propertyPresent: true });
  });
  it.each([
    ["jira.set-app-monitoring", "monitoringEnabled", true],
    ["jira.set-ipd-monitoring", "monitoringEnabled", false],
    ["jira.start-jmx-metrics", "jmxMetricsExposed", true],
    ["jira.stop-jmx-metrics", "jmxMetricsExposed", false],
  ] as const)("confirms %s through its independent original state endpoint", async (tool, field, target) => {
    const scenario = SCENARIOS.find((candidate) => candidate.tool === tool);
    if (scenario === undefined) throw new TypeError("Missing monitoring fixture");
    const observed = await observe(scenario);
    expect(observed.requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
    expect(observed.requests[0]?.url).toBe(observed.requests[2]?.url);
    expect(observed.requests[0]?.bodyJson).toBeUndefined();
    expect(observed.requests[2]?.bodyJson).toBeUndefined();
    expect(observed.result.data).toMatchObject({ outcome: "succeeded", [field]: target });
  });
  it("keeps a false native reorder observation and binds its parent without authorizing a write", async () => {
    const observed = await observe({ tool: "jira.subtask-move-availability", args: { issueIdOrKey: "SYN-1" } });
    expect(observed.requests).toHaveLength(2);
    expect(observed.requests[1]?.bodyJson).toBeUndefined();
    expect(observed.requests.every(({ method }) => method === "GET")).toBe(true);
    expect(observed.result.data).toMatchObject({ issueId: "10001", issueKey: "SYN-1", canReorderSubtasks: false });
  });
  it("binds a global remote-link selector to one native object without following its URL", async () => {
    const scenario: Scenario = { tool: "jira.remote-links", args: { issueIdOrKey: "SYN-1", globalId: "app=synthetic&id=1" },
      parameters: { issueIdOrKey: "10001" }, query: { globalId: "app=synthetic&id=1" }, primaryMethodIndex: 1 };
    const observed = await observe(scenario);
    assertPrimary(observed, scenario);
    expect(observed.requests).toHaveLength(2);
    expect(observed.requests[1]?.method).toBe("GET");
    expect(observed.requests[1]?.bodyJson).toBeUndefined();
    expect(observed.result.data).toMatchObject({ issueId: "10001", issueKey: "SYN-1", id: "71", resolved: false });
    expect(observed.result.data).not.toHaveProperty("items");
    expect(JSON.stringify(observed.result.data)).not.toContain("untrusted.invalid");
  });
  it("keeps picker contexts bound while returning only plain suggestions and trusted browse URLs", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.issue-picker");
    if (scenario === undefined) throw new TypeError("Missing issue picker fixture");
    const observed = await observe(scenario);
    expect(observed.requests).toHaveLength(3);
    expect(observed.result.data).toMatchObject({ suggestionsScope: "native-suggestions", sections: [{ id: "history", label: "Recent issues", issues: [{
      key: "SYN-2", summary: "Plain suggestion", browseUrl: "https://jira.example.invalid/context/browse/SYN-2",
    }] }] });
    expect(observed.result.data).not.toHaveProperty("total");
    expect(JSON.stringify(observed.result.data)).not.toContain("Discarded HTML");
  });
  it("keeps repeated metadata filters lossless on the native status page", async () => {
    const observed = await observe({
      tool: "jira.status-page",
      args: { startAt: 0, maxResults: 1, projectIds: ["10000", "9223372036854775807"], issueTypeIds: ["10001", "9007199254740993"] },
    });
    const request = observed.requests[0];
    if (request === undefined) throw new TypeError("Missing metadata page request");
    const url = new URL(request.url);
    expect(url.pathname).toBe("/context/rest/api/2/status/page");
    expect(url.searchParams.getAll("projectIds")).toEqual(["10000", "9223372036854775807"]);
    expect(url.searchParams.getAll("issueTypeIds")).toEqual(["10001", "9007199254740993"]);
    expect(observed.requests).toHaveLength(1);
  });
  it("keeps repeated option context IDs lossless and native page numbering unchanged", async () => {
    const observed = await observe({ tool: "jira.custom-field-options", args: {
      customFieldId: "10001", page: 2, maxResults: 1, projectIds: ["10000", "9223372036854775807"], issueTypeIds: ["10001", "9007199254740993"],
    } });
    const request = observed.requests[0];
    if (request === undefined) throw new TypeError("Missing native option request");
    const url = new URL(request.url);
    expect(url.pathname).toBe("/context/rest/api/2/customFields/10001/options");
    expect(url.searchParams.getAll("projectIds")).toEqual(["10000", "9223372036854775807"]);
    expect(url.searchParams.getAll("issueTypeIds")).toEqual(["10001", "9007199254740993"]);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("startAt")).toBe(false);
    expect(observed.result.data).toMatchObject({ page: 2, nextPage: 3, total: 3, optionsScope: "native-context-options" });
    expect(observed.result.data).not.toHaveProperty("startAt");
    expect(observed.requests).toHaveLength(1);
  });
  it.each([
    ["jira.jmx-metrics-exposed", "monitoring/jmx/areMetricsExposed", false, { exposed: false }],
    ["jira.search-max-aggregation-buckets", "searchLimits/maxAggregationBuckets", 0, { limit: 0 }],
    ["jira.search-max-result-window", "searchLimits/maxResultWindow", -1, { limit: -1 }],
  ] as const)("preserves %s's scalar native body without a wrapper or sentinel interpretation", async (tool, path, scalar, projection) => {
    const body = instanceRead(path);
    expect(body).toMatchObject({ kind: "response", status: 200, bodyText: JSON.stringify(scalar) });
    const observed = await observe({ tool, args: {} });
    expect(observed.result.data).toMatchObject(projection);
    expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", `https://jira.example.invalid/context/rest/api/2/${path}`],
    ]);
  });
  it("keeps node addresses private and maintenance observations independent", async () => {
    const nodes = await observe({ tool: "jira.cluster-nodes", args: { startAt: 0, maxResults: 1 } });
    expect(nodes.result.data).toMatchObject({ items: [{ nodeId: "node-A", alive: false, lastStateChangeTimestamp: 0 }] });
    expect(JSON.stringify(nodes.result.data)).not.toMatch(/192\.0\.2\.10|40001/u);
    const snapshot = await observe({ tool: "jira.index-snapshot-status", args: {} });
    expect(snapshot.result.data).toMatchObject({ running: false });
    expect(instanceRead("index-snapshot/isRunning")).toMatchObject({ bodyText: '{"running":false}' });
    const summary = await observe({ tool: "jira.index-summary", args: {} });
    expect(summary.result.data).toMatchObject({ issueIndex: { indexReadable: false, countInIndex: 0 }, replicationQueues: [],
      externalPlatformIndexReplay: [{ nodeId: "node-B", queueSize: 0, lastConsumedOperation: { id: -1, journalWriteTime: "Journal at 21:00" } }],
    });
    expect(summary.result.data.issueIndex).not.toHaveProperty("countInArchive");
    expect(summary.result.data.issueIndex).not.toHaveProperty("lastUpdatedInIndex");
  });
  it.each(["jira.global-version-page", "jira.component-page"] as const)(
    "keeps %s project filters lossless and an omitted total unknown", async (tool) => {
      const observed = await observe({ tool, args: { startAt: 0, maxResults: 1, projectIds: ["10000", "9223372036854775807"] } });
      const request = observed.requests[0];
      if (request === undefined) throw new TypeError("Missing native metadata page request");
      expect(new URL(request.url).searchParams.getAll("projectIds")).toEqual(["10000", "9223372036854775807"]);
      expect(observed.result.data).not.toHaveProperty("total");
      expect(observed.result.data).toMatchObject({ nextStartAt: 1 });
    },
  );
  it.each([
    [[{ value: "summary", label: "Summary" }], { columnsAvailable: true, items: [{ value: "summary", label: "Summary" }], total: 1 }],
    [{ columnConfig: "NONE" }, { columnsAvailable: false, columnConfig: "NONE" }],
  ] as const)("accepts the published filter layout form without retry or fabricated columns", async (native, expected) => {
    const observed = await observeNativeJiraOperation({ tool: "jira.filter-columns", args: { filterId: "42" } }, connection(
      () => Promise.resolve(response(native)),
    ));
    expect(observed.result.data).toMatchObject({ layoutScope: "filter", selectedFilterId: "42", ...expected });
    if (!expected.columnsAvailable) {
      expect(observed.result.data).not.toHaveProperty("items");
      expect(observed.result.data).not.toHaveProperty("total");
    }
    expect(observed.requests).toHaveLength(1);
  });
  it("keeps selected reindex IDs exact and distinguishes unreturned IDs from an empty task population", async () => {
    const observed = await observe({ tool: "jira.reindex-requests", args: {
      requestIds: ["7", "9223372036854775807"], startAt: 0, maxResults: 1,
    } });
    const request = observed.requests[0];
    if (request === undefined) throw new TypeError("Missing native reindex request");
    expect(new URL(request.url).searchParams.getAll("requestId")).toEqual(["7", "9223372036854775807"]);
    expect(observed.result.data).toMatchObject({ total: 1, requestScope: "selected-requests",
      requestedRequestIds: ["7", "9223372036854775807"], unreturnedRequestIds: ["9223372036854775807"],
      items: [{ id: "7", status: "PENDING" }],
    });
    expect(observed.requests).toHaveLength(1);
  });
  it("keeps native progress, monitoring flags and scalar metric descriptions independent", async () => {
    expect((await observe({ tool: "jira.reindex-status", args: {} })).result.data).toMatchObject({
      taskSelection: "active-or-latest", currentProgress: 0, success: false,
    });
    expect((await observe({ tool: "jira.app-monitoring", args: {} })).result.data).toMatchObject({ enabled: false });
    expect((await observe({ tool: "jira.ipd-monitoring", args: {} })).result.data).not.toHaveProperty("enabled");
    const metrics = await observe({ tool: "jira.jmx-metrics", args: {} });
    expect(metrics.result.data).toMatchObject({ metricsText: "metric.one\nmetric.two" });
    expect(metrics.requests).toHaveLength(1);
    expect(metrics.requests[0]?.method).toBe("GET");
  });
  it.each([[303, "running"], [404, "no-prior-result"]] as const)(
    "represents the native upgrade response %s without following or starting a job", async (status, upgradeState) => {
      const observed = await observeNativeJiraOperation({ tool: "jira.upgrade-result", args: {} }, connection(
        () => Promise.resolve(response({}, status)),
      ));
      expect(observed.result.data).toMatchObject({ outcome: "succeeded", upgradeState });
      expect(observed.requests).toHaveLength(1);
      expect(observed.requests[0]?.method).toBe("GET");
    },
  );
  it("binds native issue property identity before returning typed values without following key links", async () => {
    const observed = await observe({ tool: "jira.issue-property", args: { issueIdOrKey: "SYN-1", propertyKey: "view ~settings" } });
    expect(observed.requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["GET", "/context/rest/api/2/issue/SYN-1"], ["GET", "/context/rest/api/2/issue/10001/properties/view%20~settings"],
    ]);
    expect(observed.result.data).toMatchObject({ issueId: "10001", issueKey: "SYN-1", propertyKey: "view ~settings",
      items: expect.arrayContaining([
        { path: "", kind: "object", childCount: 1 }, { path: "/a~1b~0c/0", kind: "null" },
        { path: "/a~1b~0c/1", kind: "object", childCount: 0 }, { path: "/a~1b~0c/2", kind: "array", childCount: 0 },
      ]),
    });
    const keys = await observe({ tool: "jira.issue-property-keys", args: { issueIdOrKey: "SYN-1" } });
    expect(keys.result.data.items).toEqual([{ key: "view ~settings" }, { key: "a/b%" }]);
    expect(keys.requests).toHaveLength(2);
    expect(JSON.stringify(keys.result.data)).not.toContain("untrusted.invalid");
  });
  it.each(["/", "\\", "%2f", ".", ".."])("rejects unaddressable property selection %j before the real HTTP port", async (propertyKey) => {
    const http = remote();
    const provider = createJiraProviderForCatalog(() => connection(http), ["jira.issue-property"]);
    const tool = provider.tools()[0];
    if (tool === undefined) throw new TypeError("Missing issue property fixture tool");
    const result = await tool.execute({ issueIdOrKey: "SYN-1", propertyKey }, {
      invocationId: "property-refusal", correlationId: "property-refusal", signal: new AbortController().signal,
      beforeEffect: () => true,
    });
    expect(result.data).toMatchObject({ outcome: "failed", reason: "invalid-input" });
    expect(http).not.toHaveBeenCalled();
  });
  it.each(["jira.create-screen-tab", "jira.rename-screen-tab", "jira.delete-screen-tab"] as const)(
    "confirms %s through the same reviewed screen and complete native tabs after exactly one write", async (tool) => {
      const scenario = SCENARIOS.find((candidate) => candidate.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing screen tab fixture");
      const observed = await observe(scenario);
      const writeIndex = observed.requests.findIndex((request) => request.method !== "GET");
      expect(writeIndex).toBeGreaterThan(0);
      expect(observed.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
      const readback = observed.requests.slice(writeIndex + 1);
      expect(readback.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
        ["GET", "/context/rest/api/2/screens"], ["GET", "/context/rest/api/2/screens/71/tabs"],
      ]);
      const firstReadback = readback[0];
      if (firstReadback === undefined) throw new TypeError("Missing screen readback");
      expect(new URL(firstReadback.url).searchParams.get("search")).toBe("Details & QA");
      expect(observed.result.data).toMatchObject({ outcome: "succeeded", screenId: "71", tabId: tool === "jira.create-screen-tab" ? "83" : "81" });
      if (tool === "jira.delete-screen-tab")
        expect(observed.requests.slice(0, writeIndex).some(({ url }) => new URL(url).pathname === "/context/rest/api/2/screens/71/tabs/81/fields")).toBe(true);
    },
  );
  it.each(["jira.create", "jira.edit"] as const)(
    "keeps %s's approved link continuation on POST issueLink",
    async (tool) => {
      const original = SCENARIOS.find((scenario) => scenario.tool === tool);
      if (original === undefined) throw new TypeError("Missing linked mutation fixture");
      const scenario = {
        ...original,
        args: {
          ...original.args,
          links: [
            { type: "Relates", direction: "outward", issueKey: "SYN-2" },
            { type: "Relates", direction: "outward", issueKey: "SYN-3" },
          ],
        },
      };
      const observed = await observe(scenario);
      assertPrimary(observed, scenario);
      expect(observed.definition.continuationPolicy).toBe("approved-issue-links");
      const writes = observed.requests.filter((request) => request.method !== "GET");
      expect(writes).toHaveLength(2);
      const continuation = writes[1];
      expect([continuation?.method, continuation?.url]).toEqual([
        "POST",
        "https://jira.example.invalid/context/rest/api/2/issueLink",
      ]);
      expect(JSON.parse(continuation?.bodyJson ?? "{}")).toEqual({
        type: { name: "Relates" },
        inwardIssue: { key: "SYN-1" },
        outwardIssue: { key: "SYN-3" },
      });
    },
  );
});
