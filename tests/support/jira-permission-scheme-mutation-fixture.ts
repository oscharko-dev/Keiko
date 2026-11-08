import assert from "node:assert/strict";
import { settleSync } from "./jira-fixture-settle.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraPermissionSchemePorts } from "../../packages/keiko-connectors/src/jira-managed-permission-scheme-mutations.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";

export const PERMISSION_SCHEME_SNAPSHOT = {
  id: "7",
  name: "Delivery permissions",
  description: "Reviewed scheme",
  permissions: [
    { id: "21", permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "Developers" } },
    { id: "22", permission: "EDIT_ISSUES", holder: { type: "user", parameter: "user-1" } },
  ],
} as const;
const ACTOR = { expectedActorKey: "synthetic-actor" };
const REVIEW = { ...ACTOR, expectedScheme: PERMISSION_SCHEME_SNAPSHOT };
const TARGET_GRANT = {
  permission: "ADD_COMMENTS",
  holder: { type: "projectRole", parameter: "10002" },
} as const;
export const PERMISSION_SCHEME_MUTATION_CASES = [
  {
    tool: "jira.create-permission-scheme",
    method: "POST",
    path: "permissionscheme",
    args: {
      ...ACTOR,
      name: "Planning permissions",
      description: "",
      permissions: [TARGET_GRANT],
    },
    body: { name: "Planning permissions", description: "", permissions: [TARGET_GRANT] },
    receipt: { userKey: "synthetic-actor", schemeId: "9007199254740993", schemePresent: true },
  },
  {
    tool: "jira.update-permission-scheme",
    method: "PUT",
    path: "permissionscheme/7",
    args: { ...REVIEW, description: "" },
    body: { description: "" },
    receipt: { userKey: "synthetic-actor", schemeId: "7", schemePresent: true },
  },
  {
    tool: "jira.delete-permission-scheme",
    method: "DELETE",
    path: "permissionscheme/7",
    args: { ...REVIEW, confirmUnverifiedDeletion: true },
    body: undefined,
    receipt: { userKey: "synthetic-actor", schemeId: "7", schemePresent: false },
  },
  {
    tool: "jira.add-permission-grant",
    method: "POST",
    path: "permissionscheme/7/permission",
    args: { ...REVIEW, grant: TARGET_GRANT },
    body: TARGET_GRANT,
    receipt: { userKey: "synthetic-actor", schemeId: "7", permissionId: "23", grantPresent: true },
  },
  {
    tool: "jira.delete-permission-grant",
    method: "DELETE",
    path: "permissionscheme/7/permission/21",
    args: { ...REVIEW, permissionId: "21" },
    body: undefined,
    receipt: { userKey: "synthetic-actor", schemeId: "7", permissionId: "21", grantPresent: false },
  },
  {
    tool: "jira.set-permission-scheme-attribute",
    method: "PUT",
    path: "permissionscheme/7/attribute/ADMINISTER_PROJECTS.extended.enabled",
    args: {
      ...REVIEW,
      attributeKey: "ADMINISTER_PROJECTS.extended.enabled",
      expectedValue: "true",
      enabled: false,
    },
    body: undefined,
    bodyText: "false",
    receipt: {
      userKey: "synthetic-actor",
      schemeId: "7",
      attributeKey: "ADMINISTER_PROJECTS.extended.enabled",
      attributeEnabled: false,
    },
  },
] as const;
function nativeObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected synthetic native object");
  return Object.fromEntries(Object.entries(value));
}
function nativeArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError("Expected synthetic native array");
  return value.map(nativeObject);
}
function success(body?: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome {
  return { ok: true, status, body };
}
type PermissionRecord = Record<string, unknown>;
interface PermissionSchemeControls {
  denyReadback: boolean;
  absentReadback: boolean;
  throwReadback: boolean;
  missingGrants: boolean;
  wrongScheme: boolean;
  missingDescription: boolean;
  omitAckId: boolean;
  loseAck: boolean;
  writeStatus: number;
  afterWrite?: () => void;
}
interface PermissionSchemeState {
  readonly actor: { key: string; name: string; active: boolean };
  readonly schemes: Map<string, PermissionRecord>;
  readonly grants: Map<string, PermissionRecord[]>;
  readonly attributes: Map<string, unknown>;
  readonly calls: { path: string; method: string; body?: unknown; bodyText?: string }[];
  readonly controls: PermissionSchemeControls;
  writes: number;
}
export interface PermissionSchemeMutationFixture {
  readonly ports: JiraPermissionSchemePorts;
  readonly calls: PermissionSchemeState["calls"];
  readonly actor: PermissionSchemeState["actor"];
  readonly schemes: Map<string, PermissionRecord>;
  readonly grants: Map<string, PermissionRecord[]>;
  readonly attributes: Map<string, unknown>;
  readonly controls: PermissionSchemeControls;
  writes(): number;
  snapshot(): {
    schemes: PermissionRecord[];
    grants: [string, PermissionRecord[]][];
    attributes: [string, unknown][];
    writes: number;
  };
}
function permissionFailureAfterWrite(
  state: PermissionSchemeState,
): AtlassianWriteHttpOutcome | undefined {
  const { controls } = state;
  if (!state.writes) return undefined;
  if (controls.throwReadback) throw new Error("Synthetic independent scheme readback failed");
  if (controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
  if (controls.absentReadback) return { ok: false, reason: "not-found", httpStatus: 404 };
  return undefined;
}
function permissionSchemeDetail(
  state: PermissionSchemeState,
  scheme: PermissionRecord,
  id: string,
  parts: readonly string[],
): AtlassianWriteHttpOutcome {
  const { controls } = state;
  if (parts[2] === "attribute") {
    const key = decodeURIComponent(parts[3] ?? "");
    return success({ key, value: state.attributes.get(key) });
  }
  if (parts[2] === "permission")
    return success(
      controls.missingGrants ? {} : { permissions: structuredClone(state.grants.get(id)) },
    );
  const metadata: PermissionRecord = {
    id: scheme.id,
    name: scheme.name,
    description: scheme.description,
  };
  if (controls.missingDescription) delete metadata.description;
  return success({ ...metadata, ...(controls.wrongScheme ? { id: "99" } : {}) });
}
function permissionRead(state: PermissionSchemeState, path: string): AtlassianWriteHttpOutcome {
  const refused = permissionFailureAfterWrite(state);
  if (refused !== undefined) return refused;
  if (path === "myself") return success({ ...state.actor });
  if (path === "permissionscheme")
    return success({
      permissionSchemes: [...state.schemes.values()].map((scheme) => ({
        id: scheme.id,
        name: scheme.name,
        description: scheme.description,
      })),
    });
  const parts = path.split("/");
  const id = parts[1];
  const scheme = id === undefined ? undefined : state.schemes.get(id);
  if (parts[0] !== "permissionscheme" || scheme === undefined || id === undefined)
    return { ok: false, reason: "not-found", httpStatus: 404 };
  return permissionSchemeDetail(state, scheme, id, parts);
}
function permissionAck(
  state: PermissionSchemeState,
  body?: PermissionRecord,
): AtlassianWriteHttpOutcome {
  const { controls } = state;
  controls.afterWrite?.();
  if (controls.loseAck) return { ok: false, reason: "timeout" };
  return success(controls.omitAckId ? {} : body, body === undefined ? controls.writeStatus : 201);
}
function permissionCreate(state: PermissionSchemeState, body: unknown): AtlassianWriteHttpOutcome {
  const target = nativeObject(body);
  const id = "9007199254740993";
  state.schemes.set(id, { id, name: target.name, description: target.description });
  state.grants.set(
    id,
    nativeArray(target.permissions).map((grant, index) => ({ ...grant, id: String(31 + index) })),
  );
  return permissionAck(state, { id });
}
function permissionGrantChange(
  state: PermissionSchemeState,
  id: string,
  parts: readonly string[],
  method: string,
  body: unknown,
): AtlassianWriteHttpOutcome {
  const current = state.grants.get(id);
  assert.ok(current);
  if (method === "POST") {
    current.push({ ...nativeObject(body), id: "23" });
    return permissionAck(state, { id: "23" });
  }
  assert.equal(method, "DELETE");
  state.grants.set(
    id,
    current.filter((grant) => grant.id !== parts[3]),
  );
  return permissionAck(state);
}
function permissionModify(
  state: PermissionSchemeState,
  path: string,
  method: string,
  body: unknown,
): AtlassianWriteHttpOutcome {
  const parts = path.split("/");
  const id = parts[1];
  const scheme = id === undefined ? undefined : state.schemes.get(id);
  assert.ok(id !== undefined && scheme !== undefined);
  if (parts[2] === "permission") return permissionGrantChange(state, id, parts, method, body);
  if (method === "DELETE") {
    state.schemes.delete(id);
    state.grants.delete(id);
    return permissionAck(state);
  }
  assert.equal(method, "PUT");
  const target = nativeObject(body);
  if (Object.hasOwn(target, "name")) scheme.name = target.name;
  if (Object.hasOwn(target, "description")) scheme.description = target.description;
  if (Object.hasOwn(target, "permissions"))
    state.grants.set(
      id,
      nativeArray(target.permissions).map((grant, index) => ({
        ...grant,
        id: String(41 + index),
      })),
    );
  return permissionAck(state);
}
function permissionRequest(
  state: PermissionSchemeState,
  path: string,
  method: string,
  body: Parameters<JiraMutationRequest>[2],
): AtlassianWriteHttpOutcome {
  state.calls.push({
    path,
    method,
    ...(body === undefined ? {} : { body: structuredClone(body) }),
  });
  if (method === "GET") return permissionRead(state, path);
  assert.ok(!path.includes("/attribute/"), "Attribute body must use the fixed text/plain port");
  assert.equal(++state.writes, 1);
  if (state.controls.writeStatus >= 300)
    return { ok: false, reason: "permission-denied", httpStatus: state.controls.writeStatus };
  return method === "POST" && path === "permissionscheme"
    ? permissionCreate(state, body)
    : permissionModify(state, path, method, body);
}
function permissionSetAttribute(
  state: PermissionSchemeState,
  id: string,
  key: string,
  enabled: boolean,
): AtlassianWriteHttpOutcome {
  state.calls.push({
    path: `permissionscheme/${id}/attribute/${encodeURIComponent(key)}`,
    method: "PUT",
    bodyText: String(enabled),
  });
  assert.ok(state.schemes.has(id));
  assert.equal(++state.writes, 1);
  state.attributes.set(key, String(enabled));
  return permissionAck(state);
}
function permissionSchemeState(): PermissionSchemeState {
  return {
    actor: { key: "synthetic-actor", name: "synthetic-user", active: true },
    schemes: new Map<string, PermissionRecord>([["7", nativeObject(PERMISSION_SCHEME_SNAPSHOT)]]),
    grants: new Map<string, PermissionRecord[]>([
      ["7", structuredClone(PERMISSION_SCHEME_SNAPSHOT.permissions).map(nativeObject)],
    ]),
    attributes: new Map<string, unknown>([["ADMINISTER_PROJECTS.extended.enabled", "true"]]),
    calls: [],
    controls: {
      denyReadback: false,
      absentReadback: false,
      throwReadback: false,
      missingGrants: false,
      wrongScheme: false,
      missingDescription: false,
      omitAckId: false,
      loseAck: false,
      writeStatus: 204,
    },
    writes: 0,
  };
}
/** Independent mutable remote state. No product parser determines expected values or receipts. */
export function permissionSchemeMutationFixture(): PermissionSchemeMutationFixture {
  const state = permissionSchemeState();
  const request: JiraMutationRequest = (path, method = "GET", body) =>
    settleSync(() => permissionRequest(state, path, method, body));
  const ports: JiraPermissionSchemePorts = {
    request,
    setAttribute: (id, key, enabled) =>
      settleSync(() => permissionSetAttribute(state, id, key, enabled)),
  };
  return {
    ports,
    calls: state.calls,
    actor: state.actor,
    schemes: state.schemes,
    grants: state.grants,
    attributes: state.attributes,
    controls: state.controls,
    writes: () => state.writes,
    snapshot: () => ({
      schemes: structuredClone([...state.schemes.values()]),
      grants: structuredClone([...state.grants]),
      attributes: structuredClone([...state.attributes]),
      writes: state.writes,
    }),
  };
}
