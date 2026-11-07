import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { response, type SyntheticJira } from "./jira-managed-remote.js";

/** A draft dispatches journaled issue creates; every other registered write has its own case. */
export type SingleMutation = Exclude<JiraMutationOperation, "jira.draft">;
export const ATTACHED = new TextEncoder().encode("synthetic attachment body");
export const ARGUMENTS: Readonly<Record<JiraMutationOperation, CatalogJsonObject>> = {
  "jira.create": {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Changed", customfield_10000: "Required" },
  },
  "jira.edit": { issueKey: "SYN-1", fields: { summary: "Changed" } },
  "jira.assign": { issueKey: "SYN-1", assigneeName: "synthetic-user" },
  "jira.comment": { issueKey: "SYN-1", body: "Synthetic comment" },
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
  "jira.create": ISSUE_RECEIPT,
  "jira.edit": ISSUE_RECEIPT,
  "jira.assign": ISSUE_RECEIPT,
  "jira.comment": ISSUE_RECEIPT,
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
    fields: {
      summary: "Original",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: ["initial"],
    },
    comment: "",
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
export function nativeRead(
  path: string,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const resources: Readonly<Record<string, unknown>> = {
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
function platformWrite(
  path: string,
  body: Record<string, unknown>,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const project = projectWrite(path, body, state);
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
export function nativeWrite(
  path: string,
  text: string,
  state: MutationRemoteState,
): ReturnType<typeof response> | undefined {
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new TypeError("Expected fixture object body");
  return platformWrite(path, { ...body }, state) ?? agileWrite(path, { ...body }, state);
}
