import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { response } from "./jira-managed-remote.js";

type SavedMutation =
  | "jira.create-filter"
  | "jira.update-filter"
  | "jira.delete-filter"
  | "jira.set-filter-share-scope"
  | "jira.set-filter-columns"
  | "jira.reset-filter-columns"
  | "jira.add-filter-permission"
  | "jira.delete-filter-permission"
  | "jira.set-my-preference"
  | "jira.delete-my-preference";
const REVIEWED = {
  filterId: "37",
  expectedOwnerKey: "synthetic-key",
  expectedName: "Original",
  expectedJql: "project = SYN",
  expectedDescription: "",
};
const COLUMN_REVIEW = {
  filterId: "37",
  expectedOwnerKey: "synthetic-key",
  expectedColumns: ["summary"],
  expectedColumnConfig: "FILTER",
};
const GROUP_ROW = { id: "51", type: "group", view: true, edit: false, groupName: "engineers" };
const GROUP_NATIVE = {
  id: 51,
  type: "group",
  view: true,
  edit: false,
  group: { name: "engineers" },
};
export const SAVED_CONFIGURATION_ARGUMENTS: Readonly<Record<SavedMutation, CatalogJsonObject>> = {
  "jira.create-filter": {
    expectedActorKey: "synthetic-key",
    expectedDefaultShareScope: "PRIVATE",
    acceptDefaultSharing: true,
    name: "Changed",
    jql: "project = SYN",
    description: "",
  },
  "jira.update-filter": { ...REVIEWED, name: "Changed" },
  "jira.delete-filter": REVIEWED,
  "jira.set-filter-share-scope": {
    expectedActorKey: "synthetic-key",
    expectedScope: "PRIVATE",
    scope: "AUTHENTICATED",
  },
  "jira.set-filter-columns": { ...COLUMN_REVIEW, columns: ["summary", "status"] },
  "jira.reset-filter-columns": COLUMN_REVIEW,
  "jira.add-filter-permission": {
    filterId: "37",
    expectedOwnerKey: "synthetic-key",
    expectedPermissions: [],
    permission: { type: "group", groupName: "engineers", view: true, edit: false },
  },
  "jira.delete-filter-permission": {
    filterId: "37",
    expectedOwnerKey: "synthetic-key",
    expectedPermissions: [GROUP_ROW],
    permissionId: "51",
  },
  "jira.set-my-preference": {
    key: "user.notify.own.changes",
    expectedActorKey: "synthetic-key",
    expectedValue: true,
    value: false,
  },
  "jira.delete-my-preference": {
    key: "user.notify.own.changes",
    expectedActorKey: "synthetic-key",
    expectedValue: true,
  },
};
/** Observed synthetic native state is independent of SDK receipts and confirmation classification. */
export const SAVED_CONFIGURATION_REMOTE_STATE: Readonly<Record<SavedMutation, object>> = {
  "jira.create-filter": {
    savedConfiguration: {
      filter: { id: "38", name: "Changed", jql: "project = SYN", description: "" },
      filterPresent: true,
      permissions: [],
    },
  },
  "jira.update-filter": { savedConfiguration: { filter: { id: "37", name: "Changed" } } },
  "jira.delete-filter": { savedConfiguration: { filterPresent: false } },
  "jira.set-filter-share-scope": { savedConfiguration: { defaultScope: "AUTHENTICATED" } },
  "jira.set-filter-columns": {
    savedConfiguration: { columnConfig: "FILTER", columns: ["summary", "status"] },
  },
  "jira.reset-filter-columns": {
    savedConfiguration: { columnConfig: "SYSTEM", columns: ["summary"] },
  },
  "jira.add-filter-permission": { savedConfiguration: { permissions: [GROUP_NATIVE] } },
  "jira.delete-filter-permission": { savedConfiguration: { permissions: [] } },
  "jira.set-my-preference": {
    savedConfiguration: { preference: "false", preferencePresent: true },
  },
  "jira.delete-my-preference": { savedConfiguration: { preferencePresent: false } },
};
export const SAVED_CONFIGURATION_RECEIPTS: Readonly<Record<SavedMutation, CatalogJsonObject>> = {
  "jira.create-filter": {
    filterId: "38",
    userKey: "synthetic-key",
    defaultSharingAtomic: false,
    observedShareScope: "PRIVATE",
  },
  "jira.update-filter": { filterId: "37", userKey: "synthetic-key" },
  "jira.delete-filter": { filterId: "37", userKey: "synthetic-key" },
  "jira.set-filter-share-scope": {
    userKey: "synthetic-key",
    username: "synthetic-user",
    observedShareScope: "AUTHENTICATED",
  },
  "jira.set-filter-columns": { filterId: "37", userKey: "synthetic-key" },
  "jira.reset-filter-columns": { filterId: "37", userKey: "synthetic-key" },
  "jira.add-filter-permission": { filterId: "37", userKey: "synthetic-key", permissionId: "51" },
  "jira.delete-filter-permission": { filterId: "37", userKey: "synthetic-key", permissionId: "51" },
  "jira.set-my-preference": {
    userKey: "synthetic-key",
    username: "synthetic-user",
    preferenceKey: "user.notify.own.changes",
    preferencePresent: true,
  },
  "jira.delete-my-preference": {
    userKey: "synthetic-key",
    username: "synthetic-user",
    preferenceKey: "user.notify.own.changes",
    preferencePresent: false,
  },
};
const EXPECTED_OUTCOMES: Readonly<Record<SavedMutation, "succeeded" | "succeeded-unconfirmed">> = {
  "jira.create-filter": "succeeded",
  "jira.update-filter": "succeeded",
  "jira.delete-filter": "succeeded-unconfirmed",
  "jira.set-filter-share-scope": "succeeded",
  "jira.set-filter-columns": "succeeded",
  "jira.reset-filter-columns": "succeeded",
  "jira.add-filter-permission": "succeeded",
  "jira.delete-filter-permission": "succeeded",
  "jira.set-my-preference": "succeeded",
  "jira.delete-my-preference": "succeeded-unconfirmed",
};
export function expectedSavedConfigurationOutcome(
  operation: string,
): "succeeded" | "succeeded-unconfirmed" | undefined {
  const outcomes: Readonly<Record<string, "succeeded" | "succeeded-unconfirmed">> =
    EXPECTED_OUTCOMES;
  return Object.hasOwn(outcomes, operation) ? outcomes[operation] : undefined;
}
export interface SavedConfigurationRemoteState {
  filter: Record<string, unknown>;
  filterPresent: boolean;
  defaultScope: "PRIVATE" | "AUTHENTICATED";
  columns: string[];
  columnConfig: "FILTER" | "SYSTEM";
  permissions: Record<string, unknown>[];
  preference: string;
  preferencePresent: boolean;
}
export function savedConfigurationRemoteState(): SavedConfigurationRemoteState {
  return {
    filter: {
      id: "37",
      name: "Original",
      jql: "project = SYN",
      description: "",
      owner: { key: "synthetic-key", name: "synthetic-user" },
    },
    filterPresent: true,
    defaultScope: "PRIVATE",
    columns: ["summary"],
    columnConfig: "FILTER",
    permissions: [],
    preference: "true",
    preferencePresent: true,
  };
}
export function prepareSavedConfiguration(
  state: SavedConfigurationRemoteState,
  operation: string | undefined,
): void {
  if (operation === "jira.delete-filter-permission")
    state.permissions = [structuredClone(GROUP_NATIVE)];
}
export function nativeSavedConfigurationRead(
  path: string,
  state: SavedConfigurationRemoteState,
): ReturnType<typeof response> | undefined {
  if (path === "/context/rest/api/2/filter/defaultShareScope")
    return response({ scope: state.defaultScope });
  if (path === "/context/rest/api/2/mypreferences")
    return state.preferencePresent ? response(state.preference) : response({}, 404);
  if (path === "/context/rest/api/2/filter/37/columns")
    return response({
      columnConfig: state.columnConfig,
      columnLayoutItems: state.columns.map((id) => ({ id })),
    });
  if (
    path === "/context/rest/api/2/filter/37/permission" ||
    path === "/context/rest/api/2/filter/38/permission"
  )
    return response(state.permissions);
  if (path !== "/context/rest/api/2/filter/37" && path !== "/context/rest/api/2/filter/38")
    return undefined;
  return state.filterPresent && path.endsWith(`/${String(state.filter.id)}`)
    ? response({ ...state.filter, sharePermissions: state.permissions })
    : response({}, 404);
}
async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new TypeError("Expected a native JSON object");
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) result[key] = value;
  return result;
}
async function preferenceWrite(
  request: Request,
  state: SavedConfigurationRemoteState,
): Promise<ReturnType<typeof response>> {
  if (new URL(request.url).searchParams.get("key") !== "user.notify.own.changes")
    throw new TypeError("Wrong reviewed preference key");
  if (request.method === "DELETE") {
    state.preferencePresent = false;
    return response(undefined, 204);
  }
  if (request.method !== "PUT") throw new TypeError("Unexpected preference method");
  const value: unknown = await request.json();
  if (value !== "false") throw new TypeError("Expected native literal string false");
  state.preference = value;
  state.preferencePresent = true;
  return response(undefined, 204);
}
async function columnWrite(
  request: Request,
  state: SavedConfigurationRemoteState,
): Promise<ReturnType<typeof response>> {
  if (request.method === "DELETE") {
    state.columnConfig = "SYSTEM";
    state.columns = ["summary"];
    return response(undefined, 204);
  }
  const body = await objectBody(request);
  if (
    request.method !== "PUT" ||
    !Array.isArray(body.columns) ||
    !body.columns.every((field): field is string => typeof field === "string")
  )
    throw new TypeError("Expected native column list");
  state.columnConfig = "FILTER";
  state.columns = [...body.columns];
  return response({}, 200);
}
async function permissionWrite(
  request: Request,
  state: SavedConfigurationRemoteState,
): Promise<ReturnType<typeof response>> {
  if (request.method === "DELETE") {
    state.permissions = state.permissions.filter((permission) => permission.id !== 51);
    return response(undefined, 204);
  }
  const body = await objectBody(request);
  if (
    request.method !== "POST" ||
    body.type !== "group" ||
    body.groupname !== "engineers" ||
    body.edit !== false ||
    body.view !== true
  )
    throw new TypeError("Unexpected native recipient/rights");
  state.permissions.push(structuredClone(GROUP_NATIVE));
  return response(GROUP_NATIVE, 201);
}
async function filterWrite(
  request: Request,
  state: SavedConfigurationRemoteState,
): Promise<ReturnType<typeof response>> {
  if (request.method === "DELETE") {
    state.filterPresent = false;
    return response(undefined, 204);
  }
  const body = await objectBody(request);
  if (Object.keys(body).some((key) => !new Set(["name", "jql", "description"]).has(key)))
    throw new TypeError("Unexpected filter ownership/sharing override");
  if (request.method === "POST") {
    state.filter = { ...body, id: "38", owner: { key: "synthetic-key", name: "synthetic-user" } };
    state.filterPresent = true;
    state.permissions = [];
    return response(state.filter, 200);
  }
  if (request.method !== "PUT") throw new TypeError("Unexpected filter method");
  state.filter = { ...state.filter, ...body };
  return response(state.filter, 200);
}
export async function nativeSavedConfigurationWrite(
  request: Request,
  state: SavedConfigurationRemoteState,
): Promise<ReturnType<typeof response> | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/context/rest/api/2/mypreferences") return preferenceWrite(request, state);
  if (path === "/context/rest/api/2/filter/37/columns") return columnWrite(request, state);
  if (
    path === "/context/rest/api/2/filter/37/permission" ||
    path === "/context/rest/api/2/filter/37/permission/51"
  )
    return permissionWrite(request, state);
  if (path === "/context/rest/api/2/filter/defaultShareScope") {
    const body = await objectBody(request);
    if (request.method !== "PUT" || body.scope !== "AUTHENTICATED")
      throw new TypeError("Expected reviewed default sharing target");
    state.defaultScope = body.scope;
    return response({ scope: state.defaultScope });
  }
  return path === "/context/rest/api/2/filter" || path === "/context/rest/api/2/filter/37"
    ? filterWrite(request, state)
    : undefined;
}
