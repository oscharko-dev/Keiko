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
  isWatching: boolean;
  hasVoted: boolean;
  project: Record<string, unknown>;
  component: Record<string, unknown>;
  version: Record<string, unknown>;
}
function collaborationRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const type = { id: "11", name: "Relates", inward: "relates to", outward: "relates to" };
  const worklog = state.worklog;
  if (path === `issue/10001/worklog/${String(worklog.id)}`) return response(worklog);
  const bodies: Readonly<Record<string, unknown>> = {
    "issue/10001/comment/10002": {
      id: "10002",
      body: state.comment,
      self: "https://jira.example.invalid/context/rest/api/2/issue/10001/comment/10002",
    },
    issueLinkType: { issueLinkTypes: [type] },
    "issueLink/21": {
      id: "21",
      type,
      inwardIssue: { key: "SYN-1" },
      outwardIssue: { key: "SYN-2" },
    },
    "issue/10001/worklog": { startAt: 0, maxResults: 1, total: 1, worklogs: [worklog] },
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
  return undefined;
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
function assetRead(path: string): AtlassianHttpBodyResult | undefined {
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
function administrationRead(
  path: string,
  absoluteUrl: string,
): AtlassianHttpBodyResult | undefined {
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
function issueMetadata(path: string): AtlassianHttpBodyResult | undefined {
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
    assetRead(path) ??
    administrationRead(path, absoluteUrl) ??
    issueMetadata(path) ??
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
      attachment: [],
    },
    comment: "",
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
    expect(native).toHaveLength(72);
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
