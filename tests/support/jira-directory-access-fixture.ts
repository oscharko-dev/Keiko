import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraApplicationRoleConfiguration, JiraDirectoryAccessPorts } from "../../packages/keiko-connectors/src/jira-directory-access-request.js";
import type { DirectoryAccessReceipt, JiraDirectoryAccessMutation } from "../../packages/keiko-connectors/src/jira-directory-access-values.js";

export const DIRECTORY_ROLE_REVIEW = { key: "jira-software", groups: ["jira-users"], defaultGroups: ["jira-users"] } as const;
export const DIRECTORY_ROLE_TARGET = { key: "jira-software", groups: ["jira-users", "R&D team"], defaultGroups: ["R&D team"] } as const;
export const DIRECTORY_TARGET_USER = { key: "target-user", name: "Target User" } as const;
const COMMON = { expectedActorKey: "synthetic-actor" } as const;
const ACCESS = { ...COMMON, user: DIRECTORY_TARGET_USER, expectedApplicationRole: DIRECTORY_ROLE_REVIEW, acceptGlobalPermissionChange: true } as const;
const COLUMNS = { ...COMMON, user: DIRECTORY_TARGET_USER, expectedColumns: ["summary", "status", "summary"] } as const;
interface DirectoryAccessCase {
  readonly name: JiraDirectoryAccessMutation; readonly args: CatalogJsonObject;
  readonly method: "PUT" | "POST" | "DELETE"; readonly path: string;
  readonly body?: unknown; readonly receipt: DirectoryAccessReceipt; readonly confirmed: boolean;
}
export const DIRECTORY_ACCESS_FIXTURE_CASES = [
  { name: "jira.set-application-role", args: { ...COMMON, role: { expected: DIRECTORY_ROLE_REVIEW, value: DIRECTORY_ROLE_TARGET }, acceptGlobalPermissionChange: true }, method: "PUT", path: "applicationrole/jira-software", body: DIRECTORY_ROLE_TARGET, receipt: { actorUserKey: "synthetic-actor", applicationRoleKeys: ["jira-software"] }, confirmed: false },
  { name: "jira.set-application-roles", args: { ...COMMON, roles: [{ expected: DIRECTORY_ROLE_REVIEW, value: DIRECTORY_ROLE_TARGET }], acceptGlobalPermissionChange: true }, method: "PUT", path: "applicationrole", body: [DIRECTORY_ROLE_TARGET], receipt: { actorUserKey: "synthetic-actor", applicationRoleKeys: ["jira-software"] }, confirmed: false },
  { name: "jira.add-user-application", args: ACCESS, method: "POST", path: "user/application?username=Target+User&applicationKey=jira-software", receipt: { actorUserKey: "synthetic-actor", userKey: "target-user", username: "Target User", applicationRoleKeys: ["jira-software"], applicationAccessRequested: true }, confirmed: false },
  { name: "jira.remove-user-application", args: ACCESS, method: "DELETE", path: "user/application?username=Target+User&applicationKey=jira-software", receipt: { actorUserKey: "synthetic-actor", userKey: "target-user", username: "Target User", applicationRoleKeys: ["jira-software"], applicationAccessRequested: false }, confirmed: false },
  { name: "jira.set-user-columns", args: { ...COLUMNS, columns: ["status", "summary", "status"] }, method: "PUT", path: "user/columns", body: "username=Target+User&columns=status&columns=summary&columns=status", receipt: { actorUserKey: "synthetic-actor", userKey: "target-user", username: "Target User", columnIds: ["status", "summary", "status"] }, confirmed: true },
  { name: "jira.reset-user-columns", args: COLUMNS, method: "DELETE", path: "user/columns?username=Target+User", receipt: { actorUserKey: "synthetic-actor", userKey: "target-user", username: "Target User", columnsResetRequested: true }, confirmed: false },
] as const satisfies readonly DirectoryAccessCase[];

/** Independent native state/requests. No expected effects or receipts are derived from a producer. */
export function directoryAccessFixture(selected: DirectoryAccessCase) {
  const actor = { key: "synthetic-actor", name: "operator" };
  const user = { ...DIRECTORY_TARGET_USER };
  let roles: readonly JiraApplicationRoleConfiguration[] = [structuredClone(DIRECTORY_ROLE_REVIEW), { key: "jira-core", groups: [], defaultGroups: [] }];
  let columns = ["summary", "status", "summary"];
  let access: boolean | undefined;
  let effects = 0;
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  const controls = { lostAck: false, denyReadback: false, throwReadback: false, weakVersion: false, missingVersion: false,
    staleVersion: false, roleChangesBefore: false, actorChangesAfter: false, actorChangesBefore: false,
    wrongUser: false, missingGroups: false, unrelatedUnknownGroups: false, wrongReadback: false, denied: false };
  function collection(): AtlassianWriteHttpOutcome {
    const items = controls.missingGroups ? [{ key: "jira-software" }] : structuredClone(roles).map((role) =>
      controls.unrelatedUnknownGroups && role.key === "jira-core" ? { key: role.key } : role);
    const version = controls.weakVersion ? 'W/"native-role-version"' : '"native-role-version"';
    return { ok: true, status: 200, body: undefined, items,
      ...(controls.missingVersion ? {} : { applicationRoleVersion: version }) };
  }
  function read(path: string): AtlassianWriteHttpOutcome {
    if (path === "myself") {
      const changed = effects > 0 ? controls.actorChangesAfter : controls.actorChangesBefore && calls.filter((call) => call.path === "myself").length > 1;
      return { ok: true, status: 200, body: { ...actor, key: changed ? "different-actor" : actor.key } };
    }
    if (path === "applicationrole") {
      if (controls.roleChangesBefore && calls.filter((call) => call.path === path).length > 1 && effects === 0)
        roles = [{ ...DIRECTORY_ROLE_REVIEW, groups: ["jira-users", "concurrent-group"] }];
      return collection();
    }
    if (path === "applicationrole/jira-software") return { ok: true, status: 200, body: { ...DIRECTORY_ROLE_REVIEW } };
    if (path.startsWith("groups/picker?")) {
      const name = new URLSearchParams(path.split("?")[1]).get("query");
      assert.ok(name === "jira-users" || name === "R&D team");
      return { ok: true, status: 200, body: { groups: [{ name }], total: 1 } };
    }
    if (path === "user?username=Target+User" || path === "user?key=target-user")
      return { ok: true, status: 200, body: { ...user, key: controls.wrongUser ? "foreign-user" : user.key } };
    assert.equal(path, "user/columns?username=Target+User");
    return { ok: true, status: 200, body: undefined, items: columns.map((value) => ({ value })) };
  }
  function apply(): void {
    if (selected.name === "jira.set-application-role" || selected.name === "jira.set-application-roles")
      roles = [structuredClone(DIRECTORY_ROLE_TARGET), { key: "jira-core", groups: [], defaultGroups: [] }];
    if (selected.name === "jira.add-user-application") access = true;
    if (selected.name === "jira.remove-user-application") access = false;
    if (selected.name === "jira.set-user-columns") columns = ["status", "summary", "status"];
    if (selected.name === "jira.reset-user-columns") columns = ["summary", "status"];
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect) => {
    calls.push({ path, method, body: structuredClone(body), expect });
    if (effects > 0 && controls.throwReadback) throw new Error("Synthetic directory readback fault");
    if (effects > 0 && controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (method === "GET") return read(path);
    assert.equal(path, selected.path); assert.equal(method, selected.method); assert.equal(expect, "none");
    assert.deepEqual(body, selected.body);
    if (controls.denied) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (controls.staleVersion) return { ok: false, reason: "conflict", httpStatus: 412 };
    assert.equal(++effects, 1);
    if (!controls.wrongReadback) apply();
    return controls.lostAck ? { ok: false, reason: "timeout" } : { ok: true, status: 204, body: undefined };
  };
  const ports: JiraDirectoryAccessPorts = {
    roles: { read: () => request("applicationrole", "GET", undefined, "json-array"),
      write: (version, values, bulk) => {
        assert.equal(version, '"native-role-version"');
        return request(bulk ? "applicationrole" : `applicationrole/${values[0]?.key}`, "PUT", bulk ? values.map((role) => ({ ...role })) : { ...values[0] }, "none");
      } },
    application: (username, applicationKey, present) => request(`user/application?${new URLSearchParams({ username, applicationKey }).toString()}`, present ? "POST" : "DELETE", undefined, "none"),
    columns: (username, values) => {
      const form = new URLSearchParams({ username }); for (const column of values) form.append("columns", column);
      return request("user/columns", "PUT", form.toString(), "none");
    },
  };
  return { request, ports, actor, user, calls, controls, snapshot: () => ({ effects, roles: structuredClone(roles), columns: [...columns], access }) };
}
