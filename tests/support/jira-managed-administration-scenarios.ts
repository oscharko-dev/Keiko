import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { response } from "./jira-managed-remote.js";

const PROPERTY_ENTITIES = [
  "board",
  "sprint",
  "comment",
  "dashboard-item",
  "issue",
  "issue-type",
  "project",
  "user",
] as const;
type PropertyEntity = (typeof PROPERTY_ENTITIES)[number];
type PropertyMutation = `jira.${"set" | "delete"}-${PropertyEntity}-property`;
type ScreenMutation =
  "jira.create-screen-tab" | "jira.rename-screen-tab" | "jira.delete-screen-tab";
type MonitoringMutation =
  | "jira.set-app-monitoring"
  | "jira.set-ipd-monitoring"
  | "jira.start-jmx-metrics"
  | "jira.stop-jmx-metrics";
type AdministrationMutation = Extract<
  JiraMutationOperation,
  PropertyMutation | ScreenMutation | MonitoringMutation
>;
const OLD_NODES = [{ path: "", kind: "string", textValue: "Before" }] as const;
const FALSE_NODES = [{ path: "", kind: "boolean", booleanValue: false }] as const;
const REVIEWED = { propertyKey: "reviewed.setting", expectedValueNodes: OLD_NODES };
const SET = { ...REVIEWED, valueNodes: FALSE_NODES };
export const ADMINISTRATION_ARGUMENTS: Readonly<Record<AdministrationMutation, CatalogJsonObject>> =
  {
    "jira.create-screen-tab": { screenId: "5", expectedScreenName: "Screen", name: "Changed" },
    "jira.rename-screen-tab": {
      screenId: "5",
      expectedScreenName: "Screen",
      tabId: "10",
      expectedName: "Original",
      name: "Changed",
    },
    "jira.delete-screen-tab": {
      screenId: "5",
      expectedScreenName: "Screen",
      tabId: "10",
      expectedName: "Original",
      expectedFieldIds: ["summary"],
    },
    "jira.set-app-monitoring": { expectedEnabled: false, enabled: true },
    "jira.set-ipd-monitoring": { expectedEnabled: false, enabled: true },
    "jira.start-jmx-metrics": { expectedEnabled: false },
    "jira.stop-jmx-metrics": { expectedEnabled: true },
    "jira.set-board-property": { boardId: "7", ...SET },
    "jira.delete-board-property": { boardId: "7", ...REVIEWED },
    "jira.set-sprint-property": { sprintId: "9", ...SET },
    "jira.delete-sprint-property": { sprintId: "9", ...REVIEWED },
    "jira.set-comment-property": { issueIdOrKey: "SYN-1", commentId: "10002", ...SET },
    "jira.delete-comment-property": { issueIdOrKey: "SYN-1", commentId: "10002", ...REVIEWED },
    "jira.set-dashboard-item-property": { dashboardId: "31", itemId: "41", ...SET },
    "jira.delete-dashboard-item-property": { dashboardId: "31", itemId: "41", ...REVIEWED },
    "jira.set-issue-property": { issueIdOrKey: "SYN-1", ...SET },
    "jira.delete-issue-property": { issueIdOrKey: "SYN-1", ...REVIEWED },
    "jira.set-issue-type-property": { issueTypeId: "10001", ...SET },
    "jira.delete-issue-type-property": { issueTypeId: "10001", ...REVIEWED },
    "jira.set-project-property": { projectIdOrKey: "SYN", ...SET },
    "jira.delete-project-property": { projectIdOrKey: "SYN", ...REVIEWED },
    "jira.set-user-property": { userKey: "synthetic-key", ...SET },
    "jira.delete-user-property": { userKey: "synthetic-key", ...REVIEWED },
  };
// These expected remote facts are literal observations, not derived from returned receipt data.
export const ADMINISTRATION_REMOTE_STATE: Readonly<Record<AdministrationMutation, object>> = {
  "jira.create-screen-tab": {
    administration: {
      tabs: [
        { id: 10, name: "Original" },
        { id: 11, name: "Retained" },
        { id: 12, name: "Changed" },
      ],
    },
  },
  "jira.rename-screen-tab": {
    administration: {
      tabs: [
        { id: 10, name: "Changed" },
        { id: 11, name: "Retained" },
      ],
    },
  },
  "jira.delete-screen-tab": { administration: { tabs: [{ id: 11, name: "Retained" }] } },
  "jira.set-app-monitoring": { administration: { appEnabled: true } },
  "jira.set-ipd-monitoring": { administration: { ipdEnabled: true } },
  "jira.start-jmx-metrics": { administration: { jmxExposed: true } },
  "jira.stop-jmx-metrics": { administration: { jmxExposed: false } },
  "jira.set-board-property": {
    administration: { properties: { board: { present: true, value: false } } },
  },
  "jira.delete-board-property": { administration: { properties: { board: { present: false } } } },
  "jira.set-sprint-property": {
    administration: { properties: { sprint: { present: true, value: false } } },
  },
  "jira.delete-sprint-property": { administration: { properties: { sprint: { present: false } } } },
  "jira.set-comment-property": {
    administration: { properties: { comment: { present: true, value: false } } },
  },
  "jira.delete-comment-property": {
    administration: { properties: { comment: { present: false } } },
  },
  "jira.set-dashboard-item-property": {
    administration: { properties: { "dashboard-item": { present: true, value: false } } },
  },
  "jira.delete-dashboard-item-property": {
    administration: { properties: { "dashboard-item": { present: false } } },
  },
  "jira.set-issue-property": {
    administration: { properties: { issue: { present: true, value: false } } },
  },
  "jira.delete-issue-property": { administration: { properties: { issue: { present: false } } } },
  "jira.set-issue-type-property": {
    administration: { properties: { "issue-type": { present: true, value: false } } },
  },
  "jira.delete-issue-type-property": {
    administration: { properties: { "issue-type": { present: false } } },
  },
  "jira.set-project-property": {
    administration: { properties: { project: { present: true, value: false } } },
  },
  "jira.delete-project-property": {
    administration: { properties: { project: { present: false } } },
  },
  "jira.set-user-property": {
    administration: { properties: { user: { present: true, value: false } } },
  },
  "jira.delete-user-property": { administration: { properties: { user: { present: false } } } },
};
const PRESENT = { propertyKey: "reviewed.setting", propertyPresent: true };
const ABSENT = { propertyKey: "reviewed.setting", propertyPresent: false };
export const ADMINISTRATION_SUCCESS_RECEIPTS: Readonly<
  Record<AdministrationMutation, CatalogJsonObject>
> = {
  "jira.create-screen-tab": { screenId: "5", tabId: "12" },
  "jira.rename-screen-tab": { screenId: "5", tabId: "10" },
  "jira.delete-screen-tab": { screenId: "5", tabId: "10" },
  "jira.set-app-monitoring": { monitoringEnabled: true },
  "jira.set-ipd-monitoring": { monitoringEnabled: true },
  "jira.start-jmx-metrics": { jmxMetricsExposed: true },
  "jira.stop-jmx-metrics": { jmxMetricsExposed: false },
  "jira.set-board-property": { boardId: "7", ...PRESENT },
  "jira.delete-board-property": { boardId: "7", ...ABSENT },
  "jira.set-sprint-property": { sprintId: "9", ...PRESENT },
  "jira.delete-sprint-property": { sprintId: "9", ...ABSENT },
  "jira.set-comment-property": {
    issueId: "10001",
    issueKey: "SYN-1",
    commentId: "10002",
    ...PRESENT,
  },
  "jira.delete-comment-property": {
    issueId: "10001",
    issueKey: "SYN-1",
    commentId: "10002",
    ...ABSENT,
  },
  "jira.set-dashboard-item-property": { dashboardId: "31", selectedItemId: "41", ...PRESENT },
  "jira.delete-dashboard-item-property": { dashboardId: "31", selectedItemId: "41", ...ABSENT },
  "jira.set-issue-property": { issueId: "10001", issueKey: "SYN-1", ...PRESENT },
  "jira.delete-issue-property": { issueId: "10001", issueKey: "SYN-1", ...ABSENT },
  "jira.set-issue-type-property": { issueTypeId: "10001", ...PRESENT },
  "jira.delete-issue-type-property": { issueTypeId: "10001", ...ABSENT },
  "jira.set-project-property": { projectId: "10000", projectKey: "SYN", ...PRESENT },
  "jira.delete-project-property": { projectId: "10000", projectKey: "SYN", ...ABSENT },
  "jira.set-user-property": { userKey: "synthetic-key", username: "synthetic-user", ...PRESENT },
  "jira.delete-user-property": { userKey: "synthetic-key", username: "synthetic-user", ...ABSENT },
};
interface PropertyState {
  present: boolean;
  value: CatalogJsonValue;
}
export interface AdministrationRemoteState {
  tabs: { id: number; name: string }[];
  appEnabled: boolean;
  ipdEnabled: boolean;
  jmxExposed: boolean;
  properties: Record<PropertyEntity, PropertyState>;
}
export function administrationRemoteState(): AdministrationRemoteState {
  return {
    tabs: [
      { id: 10, name: "Original" },
      { id: 11, name: "Retained" },
    ],
    appEnabled: false,
    ipdEnabled: false,
    jmxExposed: false,
    properties: {
      board: { present: true, value: "Before" },
      sprint: { present: true, value: "Before" },
      comment: { present: true, value: "Before" },
      "dashboard-item": { present: true, value: "Before" },
      issue: { present: true, value: "Before" },
      "issue-type": { present: true, value: "Before" },
      project: { present: true, value: "Before" },
      user: { present: true, value: "Before" },
    },
  };
}
const PROPERTY_PATHS: Readonly<Record<PropertyEntity, string>> = {
  board: "/context/rest/agile/1.0/board/7/properties",
  sprint: "/context/rest/agile/1.0/sprint/9/properties",
  comment: "/context/rest/api/2/comment/10002/properties",
  "dashboard-item": "/context/rest/api/2/dashboard/31/items/41/properties",
  issue: "/context/rest/api/2/issue/10001/properties",
  "issue-type": "/context/rest/api/2/issuetype/10001/properties",
  project: "/context/rest/api/2/project/10000/properties",
  user: "/context/rest/api/2/user/properties",
};
function propertyTarget(path: string): { entity: PropertyEntity; value: boolean } | undefined {
  for (const entity of PROPERTY_ENTITIES) {
    const root = PROPERTY_PATHS[entity];
    if (path === root) return { entity, value: false };
    if (path === `${root}/reviewed.setting`) return { entity, value: true };
  }
  return undefined;
}
export function nativeAdministrationRead(
  path: string,
  state: AdministrationRemoteState,
): ReturnType<typeof response> | undefined {
  const target = propertyTarget(path);
  if (target !== undefined) {
    const property = state.properties[target.entity];
    if (!target.value)
      return response({ keys: property.present ? [{ key: "reviewed.setting" }] : [] });
    return property.present
      ? response({ key: "reviewed.setting", value: property.value })
      : response({}, 404);
  }
  const resources: Readonly<Record<string, unknown>> = {
    "/context/rest/api/2/screens": {
      startAt: 0,
      maxResults: 100,
      total: 1,
      isLast: true,
      screens: [{ id: 5, name: "Screen" }],
    },
    "/context/rest/api/2/screens/5/tabs": state.tabs,
    "/context/rest/api/2/screens/5/tabs/10/fields": [{ id: "summary", name: "Summary" }],
    "/context/rest/api/2/monitoring/app": { enabled: state.appEnabled },
    "/context/rest/api/2/monitoring/ipd": { enabled: state.ipdEnabled },
    "/context/rest/api/2/monitoring/jmx/areMetricsExposed": state.jmxExposed,
    "/context/rest/api/2/dashboard/31": { id: "31", name: "Dashboard" },
    "/context/rest/api/2/issuetype/10001": { id: "10001", name: "Story" },
    "/context/rest/api/2/user": { key: "synthetic-key", name: "synthetic-user", active: true },
  };
  return Object.hasOwn(resources, path) ? response(resources[path]) : undefined;
}
const MONITORING_TARGETS: Readonly<
  Record<
    string,
    {
      readonly field: "appEnabled" | "ipdEnabled" | "jmxExposed";
      readonly body: string;
      readonly value: boolean;
    }
  >
> = {
  "/context/rest/api/2/monitoring/app": {
    field: "appEnabled",
    body: '{"enabled":true}',
    value: true,
  },
  "/context/rest/api/2/monitoring/ipd": {
    field: "ipdEnabled",
    body: '{"enabled":true}',
    value: true,
  },
  "/context/rest/api/2/monitoring/jmx/startExposing": {
    field: "jmxExposed",
    body: "",
    value: true,
  },
  "/context/rest/api/2/monitoring/jmx/stopExposing": {
    field: "jmxExposed",
    body: "",
    value: false,
  },
};
function monitoringWrite(
  path: string,
  method: string,
  text: string,
  state: AdministrationRemoteState,
): ReturnType<typeof response> | undefined {
  if (!Object.hasOwn(MONITORING_TARGETS, path)) return undefined;
  const target = MONITORING_TARGETS[path];
  if (target === undefined || method !== "POST" || text !== target.body)
    throw new TypeError("Expected the reviewed native monitoring POST body");
  state[target.field] = target.value;
  return response(undefined, 204);
}
function screenWrite(
  path: string,
  method: string,
  text: string,
  state: AdministrationRemoteState,
): ReturnType<typeof response> | undefined {
  if (path === "/context/rest/api/2/screens/5/tabs" && method === "POST") {
    if (text !== '{"name":"Changed"}') throw new TypeError("Expected the reviewed new tab name");
    const tab = { id: 12, name: "Changed" };
    state.tabs.push(tab);
    return response(tab, 201);
  }
  if (path !== "/context/rest/api/2/screens/5/tabs/10") return undefined;
  if (method === "DELETE") {
    if (text !== "") throw new TypeError("Screen tab deletion has no request body");
    state.tabs = state.tabs.filter((tab) => tab.id !== 10);
  } else if (method === "PUT") {
    if (text !== '{"name":"Changed"}') throw new TypeError("Expected the reviewed renamed tab");
    state.tabs = state.tabs.map((tab) => (tab.id === 10 ? { ...tab, name: "Changed" } : tab));
  } else throw new TypeError("Unexpected screen tab method");
  return response(undefined, 204);
}
function propertyWrite(
  target: { readonly entity: PropertyEntity; readonly value: boolean },
  method: string,
  text: string,
  state: AdministrationRemoteState,
): ReturnType<typeof response> {
  if (!target.value) throw new TypeError("Property effects must name the exact reviewed key");
  if (method === "PUT") {
    if (text !== "false") throw new TypeError("Expected the reviewed scalar false property body");
    state.properties[target.entity] = { present: true, value: false };
  } else if (method === "DELETE") {
    if (text !== "") throw new TypeError("Property deletion has no request body");
    state.properties[target.entity].present = false;
  } else throw new TypeError("Unexpected property mutation method");
  return response(undefined, 204);
}
export async function nativeAdministrationWrite(
  request: Request,
  state: AdministrationRemoteState,
): Promise<ReturnType<typeof response> | undefined> {
  const path = new URL(request.url).pathname;
  const target = propertyTarget(path);
  if (target !== undefined)
    return propertyWrite(target, request.method, await request.clone().text(), state);
  if (
    !path.startsWith("/context/rest/api/2/screens/") &&
    !path.startsWith("/context/rest/api/2/monitoring/")
  )
    return undefined;
  const text = await request.clone().text();
  return (
    screenWrite(path, request.method, text, state) ??
    monitoringWrite(path, request.method, text, state)
  );
}
