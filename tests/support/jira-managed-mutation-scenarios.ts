import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { response, type SyntheticJira } from "./jira-managed-remote.js";
import { LIFECYCLE_ARGUMENTS, LIFECYCLE_RECEIPTS, LIFECYCLE_REMOTE_STATE } from "./jira-managed-lifecycle-scenarios.js";
import { CONFIGURATION_ARGUMENTS, CONFIGURATION_RECEIPTS, CONFIGURATION_REMOTE_STATE } from "./jira-managed-configuration-scenarios.js";
import { PLANNING_ARGUMENTS, PLANNING_RECEIPTS, PLANNING_REMOTE_STATE } from "./jira-managed-planning-scenarios.js";
import { SAVED_CONFIGURATION_ARGUMENTS, SAVED_CONFIGURATION_REMOTE_STATE, SAVED_CONFIGURATION_RECEIPTS,
  savedConfigurationRemoteState, nativeSavedConfigurationRead, type SavedConfigurationRemoteState } from "./jira-managed-saved-configuration-scenarios.js";
import {
  ADMINISTRATION_ARGUMENTS,
  ADMINISTRATION_REMOTE_STATE,
  ADMINISTRATION_SUCCESS_RECEIPTS,
  administrationRemoteState,
  nativeAdministrationRead,
  type AdministrationRemoteState,
} from "./jira-managed-administration-scenarios.js";

/** A draft dispatches journaled issue creates; every other registered write has its own case. */
export type SingleMutation = Exclude<JiraMutationOperation, "jira.draft">;
export const ATTACHED = new TextEncoder().encode("synthetic attachment body");
export const ARGUMENTS: Readonly<Record<JiraMutationOperation, CatalogJsonObject>> = {
  ...CONFIGURATION_ARGUMENTS,
  ...PLANNING_ARGUMENTS,
  ...LIFECYCLE_ARGUMENTS,
  ...SAVED_CONFIGURATION_ARGUMENTS,
  ...ADMINISTRATION_ARGUMENTS,
  "jira.create": {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Changed", customfield_10000: "Required" },
  },
  "jira.edit": { issueKey: "SYN-1", fields: { summary: "Changed" } },
  "jira.assign": { issueKey: "SYN-1", assigneeName: "synthetic-user" },
  "jira.comment": { issueKey: "SYN-1", body: "Synthetic comment" },
  "jira.update-comment": { issueKey: "SYN-1", commentId: "10002", body: "Changed comment" },
  "jira.create-worklog": {
    issueKey: "SYN-1",
    timeSpentSeconds: 1200,
    started: "2026-11-07T10:00:00Z",
    comment: "Investigated",
    visibility: { type: "role", value: "Developers" },
  },
  "jira.update-worklog": { issueKey: "SYN-1", worklogId: "101", comment: "Updated" },
  "jira.delete-attachment": { issueKey: "SYN-1", attachmentId: "10300", filename: "report.txt", size: ATTACHED.length },
  "jira.delete-comment": { issueKey: "SYN-1", commentId: "10002", expectedBody: "Original", expectedVisibility: { type: "role", value: "Developers" } },
  "jira.delete-worklog": { issueKey: "SYN-1", worklogId: "101", timeSpentSeconds: 3600, started: "2026-11-07T09:00:00Z", comment: "Original", visibility: { type: "role", value: "Developers" } },
  "jira.watch": { issueKey: "SYN-1" },
  "jira.unwatch": { issueKey: "SYN-1" },
  "jira.vote": { issueKey: "SYN-1" },
  "jira.unvote": { issueKey: "SYN-1" },
  "jira.transition": {
    issueKey: "SYN-1",
    transitionId: "31",
    fields: { customfield_10000: "Screen value" },
  },
  "jira.draft": {
    items: [
      {
        ref: "one",
        projectId: "10000",
        issueTypeId: "10001",
        fields: { summary: "Changed", customfield_10000: "Required" },
      },
    ],
  },
  "jira.attach": { issueKey: "SYN-1", source: { kind: "connected-file", path: "docs/report.txt" } },
  "jira.create-project": {
    key: "SYN",
    name: "Changed",
    lead: "synthetic-user",
    projectTypeKey: "software",
  },
  "jira.update-project": { projectIdOrKey: "SYN", name: "Changed" },
  "jira.create-component": { projectIdOrKey: "SYN", name: "Changed" },
  "jira.update-component": { componentId: "71", name: "Changed" },
  "jira.create-version": { projectId: "10000", name: "Changed" },
  "jira.update-version": { versionId: "81", name: "Changed" },
  "jira.board-create": { name: "Changed", type: "scrum", filterId: "42" },
  "jira.sprint-create": { name: "Changed", originBoardId: "7" },
  "jira.sprint-update": { sprintId: "9", goal: "Changed" },
  "jira.sprint-move-issues": { sprintId: "9", issues: ["SYN-1"] },
  "jira.backlog-move-issues": { issues: ["SYN-1"] },
  "jira.epic-update": { epicIdOrKey: "SYN-11", summary: "Changed" },
  "jira.epic-move-issues": { epicIdOrKey: "SYN-11", issues: ["SYN-1"] },
};

/** Observed remote state after the request, independent of returned receipts and registry metadata. */
export const REMOTE_STATE: Readonly<Record<SingleMutation, object>> = {
  ...CONFIGURATION_REMOTE_STATE,
  ...PLANNING_REMOTE_STATE,
  ...LIFECYCLE_REMOTE_STATE,
  ...SAVED_CONFIGURATION_REMOTE_STATE,
  ...ADMINISTRATION_REMOTE_STATE,
  "jira.create": {
    fields: {
      summary: "Changed",
      customfield_10000: "Required",
      project: { id: "10000" },
      issuetype: { id: "10001" },
    },
  },
  "jira.edit": { fields: { summary: "Changed", labels: ["initial"] } },
  "jira.assign": { fields: { assignee: { name: "synthetic-user" } } },
  "jira.comment": { comment: "Synthetic comment" },
  "jira.update-comment": {
    comment: "Changed comment",
    commentVisibility: { type: "role", value: "Developers" },
  },
  "jira.create-worklog": {
    worklog: { id: "102", issueId: "10001", timeSpentSeconds: 1200, comment: "Investigated" },
  },
  "jira.update-worklog": { worklog: { id: "101", issueId: "10001", comment: "Updated" } },
  "jira.delete-attachment": { fields: { attachment: [] } },
  "jira.delete-comment": { commentDeleted: true },
  "jira.delete-worklog": { worklogDeleted: true, fields: { timespent: 0, timetracking: { originalEstimateSeconds: 7200, remainingEstimateSeconds: 3600, timeSpentSeconds: 0 } } },
  "jira.watch": { isWatching: true },
  "jira.unwatch": { isWatching: false },
  "jira.vote": { hasVoted: true },
  "jira.unvote": { hasVoted: false },
  "jira.transition": { fields: { status: { id: "3" }, customfield_10000: "Screen value" } },
  "jira.attach": { fields: { attachment: [{ id: "10300", size: ATTACHED.length }] } },
  "jira.create-project": {
    project: {
      id: "10000",
      key: "SYN",
      name: "Changed",
      lead: { name: "synthetic-user" },
      projectTypeKey: "software",
    },
  },
  "jira.update-project": { project: { name: "Changed" } },
  "jira.create-component": { component: { id: "71", project: "SYN", name: "Changed" } },
  "jira.update-component": { component: { name: "Changed" } },
  "jira.create-version": { version: { id: "81", projectId: 10000, name: "Changed" } },
  "jira.update-version": { version: { name: "Changed" } },
  "jira.board-create": { board: { id: 7, name: "Changed", type: "scrum", filter: { id: 42 } } },
  "jira.sprint-create": { sprint: { id: 9, name: "Changed", state: "future", originBoardId: 7 } },
  "jira.sprint-update": { sprint: { goal: "Changed" } },
  "jira.sprint-move-issues": { agileFields: { sprint: { id: 9 } } },
  "jira.backlog-move-issues": { agileFields: { sprint: null } },
  "jira.epic-update": { epic: { summary: "Changed" } },
  "jira.epic-move-issues": { agileFields: { epic: { id: 11, key: "SYN-11" } } },
};
const ISSUE_RECEIPT = { issueKey: "SYN-1", browseUrl: "https://203.0.113.10/context/browse/SYN-1" };
const PROJECT_RECEIPT = {
  projectId: "10000",
  projectKey: "SYN",
  projectName: "Changed",
  browseUrl: "https://203.0.113.10/context/projects/SYN/summary",
};
const COMPONENT_RECEIPT = { componentId: "71", projectId: "10000", projectKey: "SYN" };
export const SUCCESS_RECEIPTS: Readonly<Record<SingleMutation, CatalogJsonObject>> = {
  ...CONFIGURATION_RECEIPTS,
  ...PLANNING_RECEIPTS,
  ...LIFECYCLE_RECEIPTS,
  ...SAVED_CONFIGURATION_RECEIPTS,
  ...ADMINISTRATION_SUCCESS_RECEIPTS,
  "jira.create": ISSUE_RECEIPT,
  "jira.edit": ISSUE_RECEIPT,
  "jira.assign": ISSUE_RECEIPT,
  "jira.comment": ISSUE_RECEIPT,
  "jira.update-comment": { ...ISSUE_RECEIPT, commentId: "10002" },
  "jira.create-worklog": { ...ISSUE_RECEIPT, issueId: "10001", worklogId: "102" },
  "jira.update-worklog": { ...ISSUE_RECEIPT, issueId: "10001", worklogId: "101" },
  "jira.delete-attachment": { ...ISSUE_RECEIPT, issueId: "10001", attachmentId: "10300" },
  "jira.delete-comment": { ...ISSUE_RECEIPT, issueId: "10001", commentId: "10002" },
  "jira.delete-worklog": { ...ISSUE_RECEIPT, issueId: "10001", worklogId: "101" },
  "jira.watch": { ...ISSUE_RECEIPT, issueId: "10001", isWatching: true },
  "jira.unwatch": { ...ISSUE_RECEIPT, issueId: "10001", isWatching: false },
  "jira.vote": { ...ISSUE_RECEIPT, issueId: "10001", hasVoted: true },
  "jira.unvote": { ...ISSUE_RECEIPT, issueId: "10001", hasVoted: false },
  "jira.transition": ISSUE_RECEIPT,
  "jira.attach": ISSUE_RECEIPT,
  "jira.create-project": PROJECT_RECEIPT,
  "jira.update-project": PROJECT_RECEIPT,
  "jira.create-component": COMPONENT_RECEIPT,
  "jira.update-component": COMPONENT_RECEIPT,
  "jira.create-version": { versionId: "81" },
  "jira.update-version": { versionId: "81" },
  "jira.board-create": { boardId: "7" },
  "jira.sprint-create": { sprintId: "9" },
  "jira.sprint-update": { sprintId: "9" },
  "jira.sprint-move-issues": { sprintId: "9", issueKeys: ["SYN-1"] },
  "jira.backlog-move-issues": { issueKeys: ["SYN-1"] },
  "jira.epic-update": { epicKey: "SYN-11" },
  "jira.epic-move-issues": { epicKey: "SYN-11", issueKeys: ["SYN-1"] },
};

export interface MutationRemoteState extends SyntheticJira {
  lifecycle: object | undefined;
  savedConfiguration: SavedConfigurationRemoteState;
  administration: AdministrationRemoteState;
  commentDeleted: boolean;
  worklogDeleted: boolean;
  worklog: Record<string, unknown>;
  isWatching: boolean;
  hasVoted: boolean;
  commentVisibility: { readonly type: "role"; readonly value: string };
  project: Record<string, unknown>;
  component: Record<string, unknown>;
  version: Record<string, unknown>;
  board: Record<string, unknown>;
  sprint: Record<string, unknown>;
  epic: Record<string, unknown>;
  agileFields: Record<string, unknown>;
}
export function mutationRemoteState(): MutationRemoteState {
  return {
    lifecycle: undefined,
    savedConfiguration: savedConfigurationRemoteState(),
    administration: administrationRemoteState(),
    fields: {
      summary: "Original",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: ["initial"],
    },
    comment: "",
    worklog: {
      id: "101",
      issueId: "10001",
      timeSpentSeconds: 3600,
      started: "2026-11-07T09:00:00.000+0000",
      comment: "Original",
      visibility: { type: "role", value: "Developers" },
    },
    commentDeleted: false,
    worklogDeleted: false,
    isWatching: false,
    hasVoted: false,
    commentVisibility: { type: "role", value: "Developers" },
    project: {
      id: "10000",
      key: "SYN",
      name: "Original",
      lead: { name: "synthetic-user" },
      projectTypeKey: "software",
    },
    component: { id: "71", project: "SYN", name: "Original" },
    version: { id: "81", projectId: 10000, name: "Original" },
    board: {
      id: 7,
      name: "Original",
      type: "scrum",
      filter: { id: 42 },
      columnConfig: { columns: [] },
    },
    sprint: { id: 9, name: "Original", state: "future", originBoardId: 7 },
    epic: { id: 11, key: "SYN-11", name: "Original", summary: "Original", done: false },
    agileFields: { sprint: { id: 8 }, epic: null },
  };
}
function nativeAttachmentRead(state: MutationRemoteState): ReturnType<typeof response> {
  const attachments = state.fields.attachment;
  const found = Array.isArray(attachments)
    ? attachments.find((item: unknown) =>
        typeof item === "object" && item !== null && "id" in item && item.id === "10300",
      )
    : undefined;
  return found === undefined ? response({}, 404) : response(found);
}
function nativeDeletionRead(
  path: string,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  if (path === "/context/rest/api/2/attachment/10300") return nativeAttachmentRead(state);
  if (path === "/context/rest/api/2/issue/10001/comment/10002" && state.commentDeleted)
    return response({}, 404);
  const comment = {
    id: "10002",
    body: state.comment,
    visibility: state.commentVisibility,
    self: "https://203.0.113.10/context/rest/api/2/issue/10001/comment/10002",
  };
  const resources: Readonly<Record<string, unknown>> = {
    "/context/rest/api/2/issue/10001": { id: "10001", key: "SYN-1", fields: state.fields },
    "/context/rest/api/2/issue/10001/worklog": {
      startAt: 0, maxResults: 1000,
      total: state.worklogDeleted ? 0 : 1,
      worklogs: state.worklogDeleted ? [] : [state.worklog],
    },
    "/context/rest/api/2/issue/10001/comment": {
      startAt: 0, maxResults: 1000,
      total: state.commentDeleted ? 0 : 1,
      comments: state.commentDeleted ? [] : [comment],
    },
  };
  return Object.hasOwn(resources, path) ? response(resources[path]) : undefined;
}
export function nativeRead(
  path: string,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const savedConfiguration = nativeSavedConfigurationRead(path, state.savedConfiguration);
  if (savedConfiguration !== undefined) return savedConfiguration;
  const administration = nativeAdministrationRead(path, state.administration);
  if (administration !== undefined) return administration;
  const deletion = nativeDeletionRead(path, state);
  if (deletion !== undefined) return deletion;
  if (path === `/context/rest/api/2/issue/10001/worklog/${String(state.worklog.id)}`)
    return state.worklogDeleted ? response({}, 404) : response(state.worklog);
  const person = { name: "synthetic-user", active: true };
  const resources: Readonly<Record<string, unknown>> = {
    "/context/rest/api/2/issue/10001/watchers": {
      isWatching: state.isWatching,
      watchCount: state.isWatching ? 1 : 0,
      watchers: state.isWatching ? [person] : [],
    },
    "/context/rest/api/2/issue/10001/votes": {
      hasVoted: state.hasVoted,
      votes: state.hasVoted ? 1 : 0,
      voters: state.hasVoted ? [person] : [],
    },
    "/context/rest/api/2/issue/10001/comment/10002": {
      id: "10002",
      self: "https://203.0.113.10/context/rest/api/2/issue/10001/comment/10002",
      body: state.comment,
      visibility: state.commentVisibility,
    },
    "/context/rest/api/2/project/SYN": state.project,
    "/context/rest/api/2/project/10000": state.project,
    "/context/rest/api/2/projectvalidate/key": { errors: {}, errorMessages: [] },
    "/context/rest/api/2/project/type/software/accessible": {
      key: "software",
      formattedKey: "Software",
    },
    "/context/rest/api/2/component/71": state.component,
    "/context/rest/api/2/version/81": state.version,
    "/context/rest/api/2/filter/42": { id: "42", name: "Scoped", jql: "project = SYN" },
    "/context/rest/agile/1.0/board/7": state.board,
    "/context/rest/agile/1.0/board/7/configuration": state.board,
    "/context/rest/agile/1.0/sprint/9": state.sprint,
    "/context/rest/agile/1.0/epic/SYN-11": state.epic,
    "/context/rest/agile/1.0/issue/SYN-1": { id: "10001", key: "SYN-1", fields: state.agileFields },
  };
  return Object.hasOwn(resources, path) ? response(resources[path]) : undefined;
}
function projectWrite(
  path: string,
  body: Record<string, unknown>,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  if (path === "/context/rest/api/2/project" || path === "/context/rest/api/2/project/10000") {
    state.project = {
      ...state.project,
      ...body,
      ...(typeof body.lead === "string" ? { lead: { name: body.lead } } : {}),
    };
    return path.endsWith("/project")
      ? response({ id: 10000, key: "SYN" }, 201)
      : response(state.project);
  }
  return undefined;
}
function commentWrite(
  path: string,
  body: Record<string, unknown>,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  if (path === "/context/rest/api/2/issue/10001/comment/10002") {
    if (
      JSON.stringify(body.visibility) !== JSON.stringify(state.commentVisibility) ||
      typeof body.body !== "string"
    )
      throw new TypeError("Expected the reviewed comment visibility to be preserved");
    state.comment = body.body;
    return response({ id: "10002", body: state.comment, visibility: state.commentVisibility });
  }
  return undefined;
}
function platformWrite(
  path: string,
  body: Record<string, unknown>,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const project = projectWrite(path, body, state) ?? commentWrite(path, body, state);
  if (project !== undefined) return project;
  if (path === "/context/rest/api/2/component" || path === "/context/rest/api/2/component/71") {
    state.component = { ...state.component, ...body };
    return response(state.component, path.endsWith("/component") ? 201 : 200);
  }
  if (path === "/context/rest/api/2/version" || path === "/context/rest/api/2/version/81") {
    state.version = { ...state.version, ...body };
    return response(state.version, path.endsWith("/version") ? 201 : 200);
  }
  return undefined;
}
function requireMembershipBody(body: Record<string, unknown>): void {
  if (!Array.isArray(body.issues) || body.issues.length !== 1 || body.issues[0] !== "SYN-1")
    throw new TypeError("Expected the selected synthetic issue membership request");
}
function agileWrite(
  path: string,
  body: Record<string, unknown>,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  switch (path) {
    case "/context/rest/agile/1.0/board":
      state.board = {
        ...state.board,
        name: body.name,
        type: body.type,
        filter: { id: body.filterId },
      };
      return response(state.board, 201);
    case "/context/rest/agile/1.0/sprint":
    case "/context/rest/agile/1.0/sprint/9":
      state.sprint = { ...state.sprint, ...body };
      return response(state.sprint, path.endsWith("/sprint") ? 201 : 200);
    case "/context/rest/agile/1.0/epic/SYN-11":
      state.epic = { ...state.epic, ...body };
      return response(state.epic);
    case "/context/rest/agile/1.0/sprint/9/issue":
      requireMembershipBody(body);
      state.agileFields.sprint = { id: 9 };
      return response(undefined, 204);
    case "/context/rest/agile/1.0/backlog/issue":
      requireMembershipBody(body);
      state.agileFields.sprint = null;
      return response(undefined, 204);
    case "/context/rest/agile/1.0/epic/SYN-11/issue":
      requireMembershipBody(body);
      state.agileFields.epic = { id: 11, key: "SYN-11" };
      return response(undefined, 204);
    default:
      return undefined;
  }
}
export function nativeDeletionWrite(
  request: Pick<Request, "method" | "url">,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  if (request.method !== "DELETE") return undefined;
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/context/rest/api/2/attachment/10300":
      state.fields.attachment = [];
      return response(undefined, 204);
    case "/context/rest/api/2/issue/10001/comment/10002":
      state.commentDeleted = true;
      return response(undefined, 204);
    case "/context/rest/api/2/issue/10001/worklog/101":
      if (url.searchParams.get("adjustEstimate") !== "leave")
        throw new TypeError("Worklog deletion must preserve the remaining estimate");
      state.worklogDeleted = true;
      state.fields.timespent = 0;
      state.fields.timetracking = { originalEstimateSeconds: 7200, remainingEstimateSeconds: 3600, timeSpentSeconds: 0 };
      return response(undefined, 204);
    default:
      return undefined;
  }
}
export function nativeParticipationWrite(
  request: Pick<Request, "method" | "url">,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const url = new URL(request.url);
  if (url.pathname === "/context/rest/api/2/issue/10001/watchers") {
    if (request.method === "DELETE") {
      if (url.searchParams.get("username") !== "synthetic-user")
        throw new TypeError("Expected only the connected user's watcher identity");
      state.isWatching = false;
    } else if (request.method === "POST") state.isWatching = true;
    else throw new TypeError("Unexpected watcher method");
    return response(undefined, 204);
  }
  if (url.pathname === "/context/rest/api/2/issue/10001/votes") {
    if (request.method === "DELETE") state.hasVoted = false;
    else if (request.method === "POST") state.hasVoted = true;
    else throw new TypeError("Unexpected voting method");
    return response(undefined, 204);
  }
  return undefined;
}
function worklogWrite(
  path: string,
  body: Record<string, unknown>,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const create = path === "/context/rest/api/2/issue/10001/worklog";
  if (!create && path !== "/context/rest/api/2/issue/10001/worklog/101") return undefined;
  if (JSON.stringify(body.visibility) !== JSON.stringify({ type: "role", value: "Developers" }))
    throw new TypeError("Expected the selected worklog visibility");
  state.worklog = {
    ...(create ? {} : state.worklog),
    ...body,
    id: create ? "102" : "101",
    issueId: "10001",
  };
  return response(state.worklog, create ? 201 : 200);
}
export function nativeWrite(
  path: string,
  text: string,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new TypeError("Expected fixture object body");
  return (
    worklogWrite(path, { ...body }, state) ??
    platformWrite(path, { ...body }, state) ??
    agileWrite(path, { ...body }, state)
  );
}
