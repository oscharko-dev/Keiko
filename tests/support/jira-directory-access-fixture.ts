import assert from "node:assert/strict";
import {
  assertDispatchedWrite,
  dispatchFixtureCall,
  type RecordedCall,
  type SharedFixtureControls,
} from "./jira-fixture-readback.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import type {
  JiraApplicationRoleConfiguration,
  JiraDirectoryAccessPorts,
} from "../../packages/keiko-connectors/src/jira-directory-access-request.js";
import type {
  DirectoryAccessReceipt,
  JiraDirectoryAccessMutation,
} from "../../packages/keiko-connectors/src/jira-directory-access-values.js";

export const DIRECTORY_ROLE_REVIEW = {
  key: "jira-software",
  groups: ["jira-users"],
  defaultGroups: ["jira-users"],
} as const;
export const DIRECTORY_ROLE_TARGET = {
  key: "jira-software",
  groups: ["jira-users", "R&D team"],
  defaultGroups: ["R&D team"],
} as const;
export const DIRECTORY_TARGET_USER = { key: "target-user", name: "Target User" } as const;
const COMMON = { expectedActorKey: "synthetic-actor" } as const;
const ACCESS = {
  ...COMMON,
  user: DIRECTORY_TARGET_USER,
  expectedApplicationRole: DIRECTORY_ROLE_REVIEW,
  acceptGlobalPermissionChange: true,
} as const;
const COLUMNS = {
  ...COMMON,
  user: DIRECTORY_TARGET_USER,
  expectedColumns: ["summary", "status", "summary"],
} as const;
interface DirectoryAccessCase {
  readonly name: JiraDirectoryAccessMutation;
  readonly args: CatalogJsonObject;
  readonly method: "PUT" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly receipt: DirectoryAccessReceipt;
  readonly confirmed: boolean;
}
export const DIRECTORY_ACCESS_FIXTURE_CASES = [
  {
    name: "jira.set-application-role",
    args: {
      ...COMMON,
      role: { expected: DIRECTORY_ROLE_REVIEW, value: DIRECTORY_ROLE_TARGET },
      acceptGlobalPermissionChange: true,
    },
    method: "PUT",
    path: "applicationrole/jira-software",
    body: DIRECTORY_ROLE_TARGET,
    receipt: { actorUserKey: "synthetic-actor", applicationRoleKeys: ["jira-software"] },
    confirmed: false,
  },
  {
    name: "jira.set-application-roles",
    args: {
      ...COMMON,
      roles: [{ expected: DIRECTORY_ROLE_REVIEW, value: DIRECTORY_ROLE_TARGET }],
      acceptGlobalPermissionChange: true,
    },
    method: "PUT",
    path: "applicationrole",
    body: [DIRECTORY_ROLE_TARGET],
    receipt: { actorUserKey: "synthetic-actor", applicationRoleKeys: ["jira-software"] },
    confirmed: false,
  },
  {
    name: "jira.add-user-application",
    args: ACCESS,
    method: "POST",
    path: "user/application?username=Target+User&applicationKey=jira-software",
    receipt: {
      actorUserKey: "synthetic-actor",
      userKey: "target-user",
      username: "Target User",
      applicationRoleKeys: ["jira-software"],
      applicationAccessRequested: true,
    },
    confirmed: false,
  },
  {
    name: "jira.remove-user-application",
    args: ACCESS,
    method: "DELETE",
    path: "user/application?username=Target+User&applicationKey=jira-software",
    receipt: {
      actorUserKey: "synthetic-actor",
      userKey: "target-user",
      username: "Target User",
      applicationRoleKeys: ["jira-software"],
      applicationAccessRequested: false,
    },
    confirmed: false,
  },
  {
    name: "jira.set-user-columns",
    args: { ...COLUMNS, columns: ["status", "summary", "status"] },
    method: "PUT",
    path: "user/columns",
    body: "username=Target+User&columns=status&columns=summary&columns=status",
    receipt: {
      actorUserKey: "synthetic-actor",
      userKey: "target-user",
      username: "Target User",
      columnIds: ["status", "summary", "status"],
    },
    confirmed: true,
  },
  {
    name: "jira.reset-user-columns",
    args: COLUMNS,
    method: "DELETE",
    path: "user/columns?username=Target+User",
    receipt: {
      actorUserKey: "synthetic-actor",
      userKey: "target-user",
      username: "Target User",
      columnsResetRequested: true,
    },
    confirmed: false,
  },
] as const satisfies readonly DirectoryAccessCase[];

interface DirectoryAccessControls extends SharedFixtureControls {
  weakVersion: boolean;
  missingVersion: boolean;
  staleVersion: boolean;
  roleChangesBefore: boolean;
  wrongUser: boolean;
  missingGroups: boolean;
  unrelatedUnknownGroups: boolean;
  wrongReadback: boolean;
  denied: boolean;
}
type DirectoryAccessCall = RecordedCall;
interface DirectoryAccessState {
  readonly selected: DirectoryAccessCase;
  readonly actor: { key: string; name: string };
  readonly user: { key: string; name: string };
  readonly calls: DirectoryAccessCall[];
  readonly controls: DirectoryAccessControls;
  roles: readonly JiraApplicationRoleConfiguration[];
  columns: string[];
  access: boolean | undefined;
  effects: number;
}
interface DirectoryAccessSnapshot {
  effects: number;
  roles: JiraApplicationRoleConfiguration[];
  columns: string[];
  access: boolean | undefined;
}
export interface DirectoryAccessFixture {
  readonly request: JiraMutationRequest;
  readonly ports: JiraDirectoryAccessPorts;
  readonly actor: DirectoryAccessState["actor"];
  readonly user: DirectoryAccessState["user"];
  readonly calls: DirectoryAccessCall[];
  readonly controls: DirectoryAccessControls;
  snapshot(): DirectoryAccessSnapshot;
}

function directoryCollection(state: DirectoryAccessState): AtlassianWriteHttpOutcome {
  const { controls } = state;
  const items = controls.missingGroups
    ? [{ key: "jira-software" }]
    : structuredClone(state.roles).map((role) =>
        controls.unrelatedUnknownGroups && role.key === "jira-core" ? { key: role.key } : role,
      );
  const version = controls.weakVersion ? 'W/"native-role-version"' : '"native-role-version"';
  return {
    ok: true,
    status: 200,
    body: undefined,
    items,
    ...(controls.missingVersion ? {} : { applicationRoleVersion: version }),
  };
}

function directoryActorRead(state: DirectoryAccessState): AtlassianWriteHttpOutcome {
  const { controls, actor } = state;
  const changed =
    state.effects > 0
      ? controls.actorChangesAfter
      : controls.actorChangesBefore &&
        state.calls.filter((call) => call.path === "myself").length > 1;
  return {
    ok: true,
    status: 200,
    body: { ...actor, key: changed ? "different-actor" : actor.key },
  };
}

function directoryRolesRead(state: DirectoryAccessState, path: string): AtlassianWriteHttpOutcome {
  if (
    state.controls.roleChangesBefore &&
    state.calls.filter((call) => call.path === path).length > 1 &&
    state.effects === 0
  )
    state.roles = [{ ...DIRECTORY_ROLE_REVIEW, groups: ["jira-users", "concurrent-group"] }];
  return directoryCollection(state);
}

function directoryGroupPickerRead(path: string): AtlassianWriteHttpOutcome {
  const name = new URLSearchParams(path.split("?")[1]).get("query");
  assert.ok(name === "jira-users" || name === "R&D team");
  return { ok: true, status: 200, body: { groups: [{ name }], total: 1 } };
}

function directoryRead(state: DirectoryAccessState, path: string): AtlassianWriteHttpOutcome {
  if (path === "myself") return directoryActorRead(state);
  if (path === "applicationrole") return directoryRolesRead(state, path);
  if (path === "applicationrole/jira-software")
    return { ok: true, status: 200, body: { ...DIRECTORY_ROLE_REVIEW } };
  if (path.startsWith("groups/picker?")) return directoryGroupPickerRead(path);
  if (path === "user?username=Target+User" || path === "user?key=target-user")
    return {
      ok: true,
      status: 200,
      body: { ...state.user, key: state.controls.wrongUser ? "foreign-user" : state.user.key },
    };
  assert.equal(path, "user/columns?username=Target+User");
  return {
    ok: true,
    status: 200,
    body: undefined,
    items: state.columns.map((value) => ({ value })),
  };
}

function applyDirectoryEffect(state: DirectoryAccessState): void {
  const { name } = state.selected;
  if (name === "jira.set-application-role" || name === "jira.set-application-roles")
    state.roles = [
      structuredClone(DIRECTORY_ROLE_TARGET),
      { key: "jira-core", groups: [], defaultGroups: [] },
    ];
  if (name === "jira.add-user-application") state.access = true;
  if (name === "jira.remove-user-application") state.access = false;
  if (name === "jira.set-user-columns") state.columns = ["status", "summary", "status"];
  if (name === "jira.reset-user-columns") state.columns = ["summary", "status"];
}

function directoryEffect(
  state: DirectoryAccessState,
  path: string,
  method: string,
  body: unknown,
  expect: unknown,
): AtlassianWriteHttpOutcome {
  const { controls, selected } = state;
  assertDispatchedWrite(
    selected,
    { path, method, body, expect },
    { body: selected.body, expect: "none" },
  );
  if (controls.denied) return { ok: false, reason: "permission-denied", httpStatus: 403 };
  if (controls.staleVersion) return { ok: false, reason: "conflict", httpStatus: 412 };
  assert.equal(++state.effects, 1);
  if (!controls.wrongReadback) applyDirectoryEffect(state);
  return controls.lostAck
    ? { ok: false, reason: "timeout" }
    : { ok: true, status: 204, body: undefined };
}

function directoryResponse(
  state: DirectoryAccessState,
  path: string,
  method: string,
  body: unknown,
  expect: unknown,
): AtlassianWriteHttpOutcome {
  return dispatchFixtureCall(
    state,
    { path, method, body, expect },
    "Synthetic directory readback fault",
    {
      read: (readPath) => directoryRead(state, readPath),
      write: (call) => directoryEffect(state, call.path, call.method, call.body, call.expect),
    },
  );
}

function directoryPorts(request: JiraMutationRequest): JiraDirectoryAccessPorts {
  return {
    roles: {
      read: () => request("applicationrole", "GET", undefined, "json-array"),
      write: (version, values, bulk): Promise<AtlassianWriteHttpOutcome> => {
        assert.equal(version, '"native-role-version"');
        return request(
          bulk ? "applicationrole" : `applicationrole/${String(values[0]?.key)}`,
          "PUT",
          bulk ? values.map((role) => ({ ...role })) : { ...values[0] },
          "none",
        );
      },
    },
    application: (username, applicationKey, present) =>
      request(
        `user/application?${new URLSearchParams({ username, applicationKey }).toString()}`,
        present ? "POST" : "DELETE",
        undefined,
        "none",
      ),
    columns: (username, values): Promise<AtlassianWriteHttpOutcome> => {
      const form = new URLSearchParams({ username });
      for (const column of values) form.append("columns", column);
      return request("user/columns", "PUT", form.toString(), "none");
    },
  };
}

function initialDirectoryState(selected: DirectoryAccessCase): DirectoryAccessState {
  return {
    selected,
    actor: { key: "synthetic-actor", name: "operator" },
    user: { ...DIRECTORY_TARGET_USER },
    roles: [
      structuredClone(DIRECTORY_ROLE_REVIEW),
      { key: "jira-core", groups: [], defaultGroups: [] },
    ],
    columns: ["summary", "status", "summary"],
    access: undefined,
    effects: 0,
    calls: [],
    controls: {
      lostAck: false,
      denyReadback: false,
      throwReadback: false,
      weakVersion: false,
      missingVersion: false,
      staleVersion: false,
      roleChangesBefore: false,
      actorChangesAfter: false,
      actorChangesBefore: false,
      wrongUser: false,
      missingGroups: false,
      unrelatedUnknownGroups: false,
      wrongReadback: false,
      denied: false,
    },
  };
}

/** Independent native state/requests. No expected effects or receipts are derived from a producer. */
export function directoryAccessFixture(selected: DirectoryAccessCase): DirectoryAccessFixture {
  const state = initialDirectoryState(selected);
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => directoryResponse(state, path, method, body, expect));
  return {
    request,
    ports: directoryPorts(request),
    actor: state.actor,
    user: state.user,
    calls: state.calls,
    controls: state.controls,
    snapshot: (): DirectoryAccessSnapshot => ({
      effects: state.effects,
      roles: structuredClone(state.roles) as JiraApplicationRoleConfiguration[],
      columns: [...state.columns],
      access: state.access,
    }),
  };
}
