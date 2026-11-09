import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

const USER = "synthetic-actor";
const ROLE = { id: "7", name: "Synthetic role", description: "Reviewed description" };
const DEFAULTS = [{ id: "70", type: "atlassian-group-role-actor", name: "current-group" }];
const MEMBERS = [{ id: "80", type: "atlassian-user-role-actor", name: "current-user" }];
const REVIEW = { expectedActorKey: USER, expectedRole: ROLE, expectedActors: DEFAULTS };
const PROJECT = { ...REVIEW, expectedActors: MEMBERS, projectIdOrKey: "SYN" };
const NEXT = { users: [{ key: "next-key", name: "next-user" }], groups: [] };
const ROLE_RECEIPT = { roleId: "7", userKey: USER, rolePresent: true };
const ACTOR_RECEIPT = { ...ROLE_RECEIPT, actorUserKeys: ["next-key"], actorGroupNames: [] };
export const ROLE_MUTATION_FIXTURE_CASES = [
  {
    name: "jira.create-role",
    args: { expectedActorKey: USER, name: "New role", description: "" },
    method: "POST",
    path: "role",
    body: { name: "New role", description: "" },
    receipt: { roleId: "9007199254740993", userKey: USER, rolePresent: true },
    confirmed: true,
  },
  {
    name: "jira.update-role",
    args: { ...REVIEW, name: "Renamed role" },
    method: "POST",
    path: "role/7",
    body: { name: "Renamed role" },
    receipt: ROLE_RECEIPT,
    confirmed: true,
  },
  {
    name: "jira.replace-role",
    args: { ...REVIEW, name: "Renamed role", description: "" },
    method: "PUT",
    path: "role/7",
    body: { name: "Renamed role", description: "" },
    receipt: ROLE_RECEIPT,
    confirmed: true,
  },
  {
    name: "jira.delete-role",
    args: {
      ...REVIEW,
      confirmUnverifiedDeletion: true,
      expectedSwapRole: { id: "9", name: "Replacement", description: "Replacement role" },
      expectedSwapActors: [],
    },
    method: "DELETE",
    path: "role/7?swap=9",
    body: undefined,
    receipt: { ...ROLE_RECEIPT, rolePresent: false, swapRoleId: "9" },
    confirmed: false,
  },
  {
    name: "jira.add-role-default-actors",
    args: { ...REVIEW, principals: NEXT },
    method: "POST",
    path: "role/7/actors",
    body: { user: ["next-key"] },
    receipt: { ...ACTOR_RECEIPT, roleActorsScope: "role-defaults", actorChange: "add" },
    confirmed: false,
  },
  {
    name: "jira.delete-role-default-actor",
    args: { ...REVIEW, principals: { users: [], groups: ["current-group"] } },
    method: "DELETE",
    path: "role/7/actors?group=current-group",
    body: undefined,
    receipt: {
      ...ROLE_RECEIPT,
      roleActorsScope: "role-defaults",
      actorChange: "remove",
      actorUserKeys: [],
      actorGroupNames: ["current-group"],
    },
    confirmed: false,
  },
  {
    name: "jira.add-project-role-actors",
    args: { ...PROJECT, principals: NEXT },
    method: "POST",
    path: "project/10000/role/7",
    body: { user: ["next-user"] },
    receipt: {
      ...ACTOR_RECEIPT,
      projectId: "10000",
      projectKey: "SYN",
      roleActorsScope: "project-membership",
      actorChange: "add",
    },
    confirmed: false,
  },
  {
    name: "jira.set-project-role-actors",
    args: { ...PROJECT, principals: { users: [], groups: ["next-group"] } },
    method: "PUT",
    path: "project/10000/role/7",
    body: {
      id: 7,
      categorisedActors: {
        "atlassian-user-role-actor": [],
        "atlassian-group-role-actor": ["next-group"],
      },
    },
    receipt: {
      ...ROLE_RECEIPT,
      projectId: "10000",
      projectKey: "SYN",
      roleActorsScope: "project-membership",
      actorChange: "replace",
      actorUserKeys: [],
      actorGroupNames: ["next-group"],
    },
    confirmed: false,
  },
  {
    name: "jira.delete-project-role-actor",
    args: {
      ...PROJECT,
      principals: { users: [{ key: "current-key", name: "current-user" }], groups: [] },
    },
    method: "DELETE",
    path: "project/10000/role/7?user=current-user",
    body: undefined,
    receipt: {
      ...ROLE_RECEIPT,
      projectId: "10000",
      projectKey: "SYN",
      roleActorsScope: "project-membership",
      actorChange: "remove",
      actorUserKeys: ["current-key"],
      actorGroupNames: [],
    },
    confirmed: false,
  },
] as const;
interface Actor {
  id: string;
  type: string;
  name: string;
}
interface RoleControls {
  lostAck: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  omitActors: boolean;
  omitActorType: boolean;
  malformedAck: boolean;
  unsafeAck: boolean;
  wrongUserKey: boolean;
  wrongReadback: boolean;
  changeProjectAfter: boolean;
  acknowledgementStatus: number;
}
interface RoleCall {
  path: string;
  method: string;
  body: Parameters<JiraMutationRequest>[2];
  expect: unknown;
}
interface RoleState {
  readonly actor: { key: string; name: string };
  readonly roles: Map<string, Record<string, unknown>>;
  readonly defaults: Map<string, Actor[]>;
  readonly project: { id: string; key: string; name: string };
  readonly users: { key: string; name: string }[];
  readonly groups: Set<string>;
  readonly controls: RoleControls;
  readonly calls: RoleCall[];
  projectActors: Actor[];
  wrote: boolean;
  nextActor: number;
}
function roleOk(body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}
function roleMissing(): AtlassianWriteHttpOutcome {
  return { ok: false, reason: "not-found", httpStatus: 404 };
}
function roleState(): RoleState {
  return {
    actor: { key: USER, name: "operator" },
    roles: new Map<string, Record<string, unknown>>([
      ["7", { ...ROLE }],
      ["9", { id: "9", name: "Replacement", description: "Replacement role" }],
    ]),
    defaults: new Map<string, Actor[]>([
      ["7", structuredClone(DEFAULTS)],
      ["9", []],
    ]),
    project: { id: "10000", key: "SYN", name: "Synthetic project" },
    users: [
      { key: "current-key", name: "current-user" },
      { key: "next-key", name: "next-user" },
    ],
    groups: new Set(["current-group", "next-group"]),
    controls: {
      lostAck: false,
      denyReadback: false,
      throwReadback: false,
      omitActors: false,
      omitActorType: false,
      malformedAck: false,
      unsafeAck: false,
      wrongUserKey: false,
      wrongReadback: false,
      changeProjectAfter: false,
      acknowledgementStatus: 200,
    },
    calls: [],
    projectActors: structuredClone(MEMBERS),
    wrote: false,
    nextActor: 100,
  };
}
function roleActorEnvelope(
  state: RoleState,
  actors: readonly Actor[],
): Readonly<Record<string, unknown>> {
  const { controls } = state;
  if (controls.omitActors) return {};
  return {
    actors: actors.map(({ id, type, name }) => ({
      id,
      name,
      ...(controls.omitActorType ? {} : { type }),
    })),
  };
}
function rolePrincipalRead(state: RoleState, url: URL): AtlassianWriteHttpOutcome | undefined {
  const { users, groups, controls } = state;
  if (url.pathname === "/user") {
    const user = users.find(
      (item) =>
        item.name === url.searchParams.get("username") || item.key === url.searchParams.get("key"),
    );
    return user === undefined
      ? roleMissing()
      : roleOk({ ...user, ...(controls.wrongUserKey ? { key: "other-key" } : {}) });
  }
  if (url.pathname === "/groups/picker") {
    const query = url.searchParams.get("query") ?? "";
    const found = [...groups].filter((name) => name.includes(query));
    return roleOk({ groups: found.map((name) => ({ name })), total: found.length });
  }
  return undefined;
}
function roleProjectRead(state: RoleState, url: URL): AtlassianWriteHttpOutcome | undefined {
  if (url.pathname === "/project/SYN" || url.pathname === "/project/10000")
    return roleOk({
      ...state.project,
      ...(state.wrote && state.controls.changeProjectAfter ? { key: "OTHER" } : {}),
    });
  if (url.pathname === "/project/10000/role/7")
    return roleOk({
      ...state.roles.get("7"),
      ...roleActorEnvelope(state, state.projectActors),
    });
  return undefined;
}
function roleByIdRead(state: RoleState, url: URL): AtlassianWriteHttpOutcome {
  const selected = /^\/role\/(\d+)(\/actors)?$/u.exec(url.pathname);
  const id = selected?.[1];
  const role = id === undefined ? undefined : state.roles.get(id);
  if (role === undefined || id === undefined) return roleMissing();
  if (selected?.[2] !== undefined)
    return roleOk(roleActorEnvelope(state, state.defaults.get(id) ?? []));
  return roleOk({
    ...role,
    ...(state.wrote && state.controls.wrongReadback ? { name: "Concurrent rename" } : {}),
  });
}
function roleRead(state: RoleState, url: URL): AtlassianWriteHttpOutcome {
  if (url.pathname === "/myself") return roleOk(state.actor);
  if (url.pathname === "/role")
    return { ok: true, status: 200, body: undefined, items: [...state.roles.values()] };
  return rolePrincipalRead(state, url) ?? roleProjectRead(state, url) ?? roleByIdRead(state, url);
}
/** Native Jira names default (global) role actors by user key and project role actors by username. */
function roleAdditions(
  state: RoleState,
  body: Readonly<Record<string, unknown>>,
  userIdentifier: "key" | "name",
): Actor[] {
  const result: Actor[] = [];
  for (const [key, type] of [
    ["user", "atlassian-user-role-actor"],
    ["group", "atlassian-group-role-actor"],
  ] as const) {
    const names = body[key];
    if (names === undefined) continue;
    assert.ok(Array.isArray(names));
    for (const name of names) {
      assert.ok(typeof name === "string");
      const user =
        type === "atlassian-user-role-actor"
          ? state.users.find((item) => item[userIdentifier] === name)
          : undefined;
      // An unresolvable user identifier is refused natively before anything is written.
      if (type === "atlassian-user-role-actor") assert.ok(user, "Unknown native user identifier");
      result.push({ id: String(state.nextActor++), type, name: user?.name ?? name });
    }
  }
  return result;
}
function roleModifyActors(
  state: RoleState,
  old: readonly Actor[],
  url: URL,
  method: string,
  raw: Readonly<Record<string, unknown>> | undefined,
): Actor[] {
  const identifier = url.pathname === "/role/7/actors" ? "key" : "name";
  if (method === "DELETE")
    return old.filter(
      (item) =>
        item.name !==
        (item.type === "atlassian-user-role-actor"
          ? state.users.find((user) => user[identifier] === url.searchParams.get("user"))?.name
          : url.searchParams.get("group")),
    );
  assert.ok(raw);
  if (method === "POST") return [...old, ...roleAdditions(state, raw, identifier)];
  assert.equal(raw.id, 7);
  const categorised = asRecord(raw.categorisedActors);
  assert.ok(categorised);
  return roleAdditions(
    state,
    {
      user: categorised["atlassian-user-role-actor"],
      group: categorised["atlassian-group-role-actor"],
    },
    identifier,
  );
}
function roleApplyEffect(
  state: RoleState,
  url: URL,
  method: string,
  raw: Readonly<Record<string, unknown>> | undefined,
): void {
  const { roles, defaults } = state;
  if (url.pathname === "/role" && method === "POST") {
    assert.ok(raw);
    roles.set("9007199254740993", { id: "9007199254740993", ...raw });
    defaults.set("9007199254740993", []);
  } else if (url.pathname === "/role/7/actors")
    defaults.set("7", roleModifyActors(state, defaults.get("7") ?? [], url, method, raw));
  else if (url.pathname === "/project/10000/role/7")
    state.projectActors = roleModifyActors(state, state.projectActors, url, method, raw);
  else if (url.pathname === "/role/7" && method === "DELETE") {
    roles.delete("7");
    defaults.delete("7");
  } else if (url.pathname === "/role/7") {
    assert.ok(raw);
    roles.set("7", { ...roles.get("7"), ...raw });
  } else throw new TypeError("Unexpected synthetic role effect");
}
function roleEffect(
  state: RoleState,
  url: URL,
  method: string,
  body: Parameters<JiraMutationRequest>[2],
): AtlassianWriteHttpOutcome {
  const { controls } = state;
  roleApplyEffect(state, url, method, asRecord(body));
  state.wrote = true;
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  const id = controls.unsafeAck ? 9007199254740992 : "9007199254740993";
  return {
    ok: true,
    status: controls.acknowledgementStatus,
    body: url.pathname === "/role" && !controls.malformedAck ? { id } : undefined,
  };
}
function roleDispatch(state: RoleState, call: RoleCall): AtlassianWriteHttpOutcome {
  const { path, method, body } = call;
  const { controls } = state;
  if (state.wrote && controls.throwReadback) throw new Error("Synthetic role readback defect");
  if (state.wrote && controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  const url = new URL(path, "https://synthetic.invalid/");
  return method === "GET" ? roleRead(state, url) : roleEffect(state, url, method, body);
}
export function roleMutationFixture(): {
  readonly request: JiraMutationRequest;
  readonly calls: RoleCall[];
  readonly controls: RoleControls;
  readonly actor: { key: string; name: string };
  readonly roles: Map<string, Record<string, unknown>>;
  readonly defaults: Map<string, Actor[]>;
  readonly project: { id: string; key: string; name: string };
  readonly users: { key: string; name: string }[];
  readonly groups: Set<string>;
  readonly snapshot: () => CatalogJsonObject;
} {
  const state = roleState();
  const { actor, roles, defaults, project, users, groups, controls, calls } = state;
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => {
      const call = { path, method, body, expect };
      calls.push(call);
      return roleDispatch(state, call);
    });
  return {
    request,
    calls,
    controls,
    actor,
    roles,
    defaults,
    project,
    users,
    groups,
    snapshot: (): CatalogJsonObject => ({
      roles: [...roles.values()].map((role) => ({ id: String(role.id), name: String(role.name) })),
      defaultActors: (defaults.get("7") ?? []).map(({ id, name, type }) => ({ id, name, type })),
      projectActors: state.projectActors.map(({ id, name, type }) => ({ id, name, type })),
    }),
  };
}
