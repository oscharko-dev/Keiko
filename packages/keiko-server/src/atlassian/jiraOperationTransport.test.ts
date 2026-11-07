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
import { jiraOperationContracts } from "./jiraManagedProvider.js";
import {
  observeNativeJiraOperation,
  assertNativeJiraPrimary as assertPrimary,
  type Scenario,
  type Observation,
} from "../../../../tests/support/jira-operation-transport-contract.js";

const ISSUE_PARAMETERS = { issueIdOrKey: "SYN-1" };
const PAGING = { startAt: "0", maxResults: "25" };
const CREATE = {
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "After", customfield_10000: "Required" },
};
// Inputs and selected resource identities are independent fixtures, not generated from the registry.
const SCENARIOS: readonly Scenario[] = [
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
  const directory = directoryRead(path) ?? accessRead(path) ?? coreMetadataRead(path) ?? instanceRead(path) ?? roleRead(path) ?? configurationRead(path, absoluteUrl);
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
    projectRead(path, state) ??
    structureRead(path, state) ??
    collaborationRead(path, state) ??
    participationRead(path, state) ??
    filterRead(path) ??
    savedViewRead(path) ??
    assetRead(path, state) ??
    administrationRead(path, absoluteUrl) ??
    issueMetadata(path, state) ??
    fixtureRead(absolute, state)
  );
}
function remote(tool?: string): ReturnType<typeof vi.fn<AtlassianHttpBodyPort>> {
  const state: RemoteState = {
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
      return Promise.resolve(remoteRead(path, absolute, state, request.url));
    return Promise.resolve(
      path === "project" || path === "project/10000"
        ? projectWrite(request, state)
        : (participationWrite(path, request.method, state) ??
            assetWrite(path, request, state) ??
            worklogWrite(path, request, state) ??
            collaborationWrite(path, request, state) ??
            structureWrite(path, request, state) ??
            fixtureWrite(absolute, request.bodyJson, state, request.upload)),
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
    expect(native).toHaveLength(152);
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
