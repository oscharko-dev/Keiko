import assert from "node:assert/strict";
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
/** Independent mutable remote state. No product parser determines expected values or receipts. */
export function permissionSchemeMutationFixture() {
  const actor = { key: "synthetic-actor", name: "synthetic-user", active: true };
  const schemes = new Map<string, Record<string, unknown>>([
    ["7", nativeObject(PERMISSION_SCHEME_SNAPSHOT)],
  ]);
  const grants = new Map<string, Record<string, unknown>[]>([
    ["7", structuredClone(PERMISSION_SCHEME_SNAPSHOT.permissions).map(nativeObject)],
  ]);
  const attributes = new Map<string, unknown>([["ADMINISTER_PROJECTS.extended.enabled", "true"]]);
  const calls: { path: string; method: string; body?: unknown; bodyText?: string }[] = [];
  const controls: {
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
  } = {
    denyReadback: false,
    absentReadback: false,
    throwReadback: false,
    missingGrants: false,
    wrongScheme: false,
    missingDescription: false,
    omitAckId: false,
    loseAck: false,
    writeStatus: 204,
  };
  let writes = 0;
  function failureAfterWrite(): AtlassianWriteHttpOutcome | undefined {
    if (!writes) return undefined;
    if (controls.throwReadback) throw new Error("Synthetic independent scheme readback failed");
    if (controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (controls.absentReadback) return { ok: false, reason: "not-found", httpStatus: 404 };
    return undefined;
  }
  function read(path: string): AtlassianWriteHttpOutcome {
    const refused = failureAfterWrite();
    if (refused !== undefined) return refused;
    if (path === "myself") return success({ ...actor });
    if (path === "permissionscheme")
      return success({
        permissionSchemes: [...schemes.values()].map((scheme) => ({
          id: scheme.id,
          name: scheme.name,
          description: scheme.description,
        })),
      });
    const parts = path.split("/");
    const id = parts[1];
    const scheme = id === undefined ? undefined : schemes.get(id);
    if (parts[0] !== "permissionscheme" || scheme === undefined || id === undefined)
      return { ok: false, reason: "not-found", httpStatus: 404 };
    if (parts[2] === "attribute") {
      const key = decodeURIComponent(parts[3] ?? "");
      return success({ key, value: attributes.get(key) });
    }
    if (parts[2] === "permission")
      return success(
        controls.missingGrants ? {} : { permissions: structuredClone(grants.get(id)) },
      );
    const metadata: Record<string, unknown> = {
      id: scheme.id,
      name: scheme.name,
      description: scheme.description,
    };
    if (controls.missingDescription) delete metadata.description;
    return success({ ...metadata, ...(controls.wrongScheme ? { id: "99" } : {}) });
  }
  function ack(body?: Record<string, unknown>): AtlassianWriteHttpOutcome {
    controls.afterWrite?.();
    if (controls.loseAck) return { ok: false, reason: "timeout" };
    return success(controls.omitAckId ? {} : body, body === undefined ? controls.writeStatus : 201);
  }
  function create(body: unknown): AtlassianWriteHttpOutcome {
    const target = nativeObject(body);
    const id = "9007199254740993";
    schemes.set(id, { id, name: target.name, description: target.description });
    grants.set(
      id,
      nativeArray(target.permissions).map((grant, index) => ({ ...grant, id: String(31 + index) })),
    );
    return ack({ id });
  }
  function modify(path: string, method: string, body: unknown): AtlassianWriteHttpOutcome {
    const parts = path.split("/");
    const id = parts[1];
    const scheme = id === undefined ? undefined : schemes.get(id);
    assert.ok(id !== undefined && scheme !== undefined);
    if (parts[2] === "permission") {
      const current = grants.get(id);
      assert.ok(current);
      if (method === "POST") {
        current.push({ ...nativeObject(body), id: "23" });
        return ack({ id: "23" });
      }
      assert.equal(method, "DELETE");
      grants.set(
        id,
        current.filter((grant) => grant.id !== parts[3]),
      );
      return ack();
    }
    if (method === "DELETE") {
      schemes.delete(id);
      grants.delete(id);
      return ack();
    }
    assert.equal(method, "PUT");
    const target = nativeObject(body);
    if (Object.hasOwn(target, "name")) scheme.name = target.name;
    if (Object.hasOwn(target, "description")) scheme.description = target.description;
    if (Object.hasOwn(target, "permissions"))
      grants.set(
        id,
        nativeArray(target.permissions).map((grant, index) => ({
          ...grant,
          id: String(41 + index),
        })),
      );
    return ack();
  }
  const request: JiraMutationRequest = async (path, method = "GET", body) => {
    calls.push({ path, method, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (method === "GET") return read(path);
    assert.ok(!path.includes("/attribute/"), "Attribute body must use the fixed text/plain port");
    assert.equal(++writes, 1);
    if (controls.writeStatus >= 300)
      return { ok: false, reason: "permission-denied", httpStatus: controls.writeStatus };
    return method === "POST" && path === "permissionscheme"
      ? create(body)
      : modify(path, method, body);
  };
  const ports: JiraPermissionSchemePorts = {
    request,
    setAttribute: async (id, key, enabled) => {
      calls.push({
        path: `permissionscheme/${id}/attribute/${encodeURIComponent(key)}`,
        method: "PUT",
        bodyText: String(enabled),
      });
      assert.ok(schemes.has(id));
      assert.equal(++writes, 1);
      attributes.set(key, String(enabled));
      return ack();
    },
  };
  return {
    ports,
    calls,
    actor,
    schemes,
    grants,
    attributes,
    controls,
    writes: () => writes,
    snapshot: () => ({
      schemes: structuredClone([...schemes.values()]),
      grants: structuredClone([...grants]),
      attributes: structuredClone([...attributes]),
      writes,
    }),
  };
}
