import { expect, it } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraFilterMutation, isJiraFilterMutation } from "./jira-managed-filter-mutations.js";
import { executeJiraFilterColumnMutation, isJiraFilterColumnMutation } from "./jira-managed-filter-column-mutations.js";
import { executeJiraFilterPermissionMutation, isJiraFilterPermissionMutation } from "./jira-managed-filter-permission-mutations.js";
import { executeJiraPreferenceMutation, isJiraPreferenceMutation } from "./jira-managed-preference-mutations.js";
import { JIRA_NONSECRET_PREFERENCE_KINDS } from "./jira-managed-application-settings.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import type { JiraSavedConfigurationAttempt } from "./jira-saved-configuration-values.js";
import { scriptedJiraMutationRequest as port } from "./jira-test-request/_support.js";

const ACTOR: AtlassianWriteHttpOutcome = { ok: true, status: 200, body: { key: "synthetic-key", name: "synthetic-user" } };
const FILTER_BODY = { id: "37", name: "Reviewed", jql: "project = SYN", description: "", owner: { key: "synthetic-key", name: "synthetic-user" } };
function object(body: Readonly<Record<string, unknown>>, status = 200): AtlassianWriteHttpOutcome { return { ok: true, status, body }; }
function list(items: readonly unknown[]): AtlassianWriteHttpOutcome { return { ok: true, status: 200, body: undefined, items }; }
function scalar(value: string): AtlassianWriteHttpOutcome { return { ok: true, status: 200, body: undefined, scalar: value }; }
const ACK: AtlassianWriteHttpOutcome = { ok: true, status: 204, body: undefined };
const DENIED: AtlassianWriteHttpOutcome = { ok: false, reason: "permission-denied", httpStatus: 403 };
const MISSING: AtlassianWriteHttpOutcome = { ok: false, reason: "not-found", httpStatus: 404 };
const FILTER = object(FILTER_BODY);
const PRIVATE = object({ scope: "PRIVATE" });
const REVIEWED = { filterId: "37", expectedOwnerKey: "synthetic-key", expectedName: "Reviewed", expectedJql: "project = SYN", expectedDescription: "" };
const GROUP = { id: 51, type: "group", view: true, edit: false, group: { name: "engineers" } };
const GROUP_ROW = { id: "51", type: "group", view: true, edit: false, groupName: "engineers" };
const GROUP_TARGET = { type: "group", view: true, edit: false, groupName: "engineers" };
const COLUMN_INPUT = { filterId: "37", expectedOwnerKey: "synthetic-key", expectedColumns: ["summary"], expectedColumnConfig: "FILTER" };
const COLUMNS = object({ columnConfig: "FILTER", columnLayoutItems: [{ id: "summary" }] });
type Executor = (args: CatalogJsonObject, request: JiraMutationRequest, check?: boolean) => Promise<JiraSavedConfigurationAttempt>;
interface Scenario { readonly name: string; readonly execute: Executor; readonly args: CatalogJsonObject; readonly before: readonly AtlassianWriteHttpOutcome[];
  readonly ack: AtlassianWriteHttpOutcome; readonly after: readonly AtlassianWriteHttpOutcome[]; readonly path: string; readonly method: string;
  readonly body?: unknown; readonly receipt: CatalogJsonObject; readonly confirmed?: false }
const CASES: readonly Scenario[] = [
  { name: "create-filter", execute: (args, request, check) => executeJiraFilterMutation("jira.create-filter", args, request, check),
    args: { expectedActorKey: "synthetic-key", expectedDefaultShareScope: "PRIVATE", acceptDefaultSharing: true, name: "Reviewed", jql: "project = SYN", description: "" },
    before: [ACTOR, PRIVATE, ACTOR, PRIVATE], ack: object({ id: "37" }), after: [ACTOR, FILTER, list([])], path: "filter", method: "POST",
    body: { name: "Reviewed", jql: "project = SYN", description: "" }, receipt: { filterId: "37", userKey: "synthetic-key", defaultSharingAtomic: false, observedShareScope: "PRIVATE" } },
  { name: "update-filter", execute: (args, request, check) => executeJiraFilterMutation("jira.update-filter", args, request, check),
    args: { ...REVIEWED, name: "Changed" }, before: [ACTOR, FILTER], ack: ACK, after: [ACTOR, object({ ...FILTER_BODY, name: "Changed" })], path: "filter/37", method: "PUT", body: { name: "Changed" }, receipt: { filterId: "37", userKey: "synthetic-key" } },
  { name: "delete-filter", execute: (args, request, check) => executeJiraFilterMutation("jira.delete-filter", args, request, check),
    args: REVIEWED, before: [ACTOR, FILTER], ack: ACK, after: [ACTOR, MISSING], path: "filter/37", method: "DELETE", confirmed: false, receipt: { filterId: "37", userKey: "synthetic-key" } },
  { name: "set-filter-share-scope", execute: (args, request, check) => executeJiraFilterMutation("jira.set-filter-share-scope", args, request, check),
    args: { expectedActorKey: "synthetic-key", expectedScope: "PRIVATE", scope: "AUTHENTICATED" }, before: [ACTOR, PRIVATE], ack: ACK, after: [ACTOR, object({ scope: "AUTHENTICATED" })], path: "filter/defaultShareScope", method: "PUT", body: { scope: "AUTHENTICATED" }, receipt: { userKey: "synthetic-key", username: "synthetic-user", observedShareScope: "AUTHENTICATED" } },
  { name: "set-filter-columns", execute: (args, request, check) => executeJiraFilterColumnMutation("jira.set-filter-columns", args, request, check),
    args: { ...COLUMN_INPUT, columns: ["summary", "status"] }, before: [ACTOR, FILTER, COLUMNS], ack: ACK, after: [ACTOR, FILTER, object({ columnConfig: "FILTER", columnLayoutItems: [{ id: "summary" }, { id: "status" }] })], path: "filter/37/columns", method: "PUT", body: { columns: ["summary", "status"] }, receipt: { filterId: "37", userKey: "synthetic-key" } },
  { name: "reset-filter-columns", execute: (args, request, check) => executeJiraFilterColumnMutation("jira.reset-filter-columns", args, request, check),
    args: COLUMN_INPUT, before: [ACTOR, FILTER, COLUMNS], ack: ACK, after: [ACTOR, FILTER, object({ columnConfig: "SYSTEM", columnLayoutItems: [{ id: "summary" }] })], path: "filter/37/columns", method: "DELETE", receipt: { filterId: "37", userKey: "synthetic-key" } },
  { name: "add-filter-permission", execute: (args, request, check) => executeJiraFilterPermissionMutation("jira.add-filter-permission", args, request, check),
    args: { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [], permission: GROUP_TARGET }, before: [ACTOR, FILTER, list([])], ack: ACK, after: [ACTOR, FILTER, list([GROUP])], path: "filter/37/permission", method: "POST", body: { type: "group", view: true, edit: false, groupname: "engineers" }, receipt: { filterId: "37", userKey: "synthetic-key", permissionId: "51" } },
  { name: "delete-filter-permission", execute: (args, request, check) => executeJiraFilterPermissionMutation("jira.delete-filter-permission", args, request, check),
    args: { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [GROUP_ROW], permissionId: "51" }, before: [ACTOR, FILTER, list([GROUP])], ack: ACK, after: [ACTOR, FILTER, list([])], path: "filter/37/permission/51", method: "DELETE", receipt: { filterId: "37", userKey: "synthetic-key", permissionId: "51" } },
  { name: "set-my-preference", execute: (args, request, check) => executeJiraPreferenceMutation("jira.set-my-preference", args, request, check),
    args: { key: "user.notify.own.changes", expectedActorKey: "synthetic-key", expectedValue: true, value: false }, before: [ACTOR, scalar("true"), ACTOR], ack: ACK, after: [ACTOR, scalar("false")], path: "mypreferences?key=user.notify.own.changes", method: "PUT", body: "false", receipt: { userKey: "synthetic-key", username: "synthetic-user", preferenceKey: "user.notify.own.changes", preferencePresent: true } },
  { name: "delete-my-preference", execute: (args, request, check) => executeJiraPreferenceMutation("jira.delete-my-preference", args, request, check),
    args: { key: "user.notify.own.changes", expectedActorKey: "synthetic-key", expectedValue: true }, before: [ACTOR, scalar("true"), ACTOR], ack: ACK, after: [ACTOR, MISSING], path: "mypreferences?key=user.notify.own.changes", method: "DELETE", confirmed: false, receipt: { userKey: "synthetic-key", username: "synthetic-user", preferenceKey: "user.notify.own.changes", preferencePresent: false } },
];
const FILTER_OWNER_CASES = CASES.filter(({ name }) => name === "set-filter-columns" || name === "reset-filter-columns" ||
  name === "add-filter-permission" || name === "delete-filter-permission");
it.each(CASES)("performs one fixed $name effect and independently classifies the actual readback", async (scenario) => {
  const request = port([...scenario.before, scenario.ack, ...scenario.after]);
  const result = await scenario.execute(scenario.args, request);
  expect(result).toMatchObject({ ok: scenario.confirmed !== false, receipt: scenario.receipt });
  const writes = request.mock.calls.filter(([, method]) => method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.slice(0, 3)).toEqual([scenario.path, scenario.method, scenario.body]);
  expect(request).toHaveBeenCalledTimes(scenario.before.length + 1 + scenario.after.length);
});
it.each(CASES)("preflights $name without any effect", async (scenario) => {
  const request = port(scenario.before);
  expect(await scenario.execute(scenario.args, request, true)).toEqual({ ok: true, receipt: {} });
  expect(request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
});
it.each(CASES)("retains lost $name acknowledgements without replay", async (scenario) => {
  const request = port([...scenario.before, { ok: false, reason: "timeout" }]);
  expect(await scenario.execute(scenario.args, request)).toMatchObject({ ok: false, reason: "timeout" });
  expect(request.mock.calls.filter(([, method]) => method !== "GET")).toHaveLength(1);
});
it.each(CASES)("keeps denied $name readback uncertain with known target", async (scenario) => {
  const request = port([...scenario.before, scenario.ack, DENIED]);
  const result = await scenario.execute(scenario.args, request);
  expect(result).toMatchObject({ ok: false, reason: "permission-denied" });
  if (result.ok) throw new TypeError("Unexpected confirmed write");
  expect(result.receipt).toBeDefined();
  expect(request.mock.calls.filter(([, method]) => method !== "GET")).toHaveLength(1);
});
it.each(CASES)("refuses changed actor identity before $name", async (scenario) => {
  const request = port([object({ key: "another-key", name: "synthetic-user" })]);
  expect(await scenario.execute(scenario.args, request)).toMatchObject({ ok: false, reason: "conflict" });
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(FILTER_OWNER_CASES)("refuses changed filter ownership before $name without a mutation receipt", async (scenario) => {
  const changed = object({ ...FILTER_BODY, owner: { key: "another-key", name: "another-user" } });
  const request = port([ACTOR, changed]);
  const result = await scenario.execute(scenario.args, request);
  expect(result).toMatchObject({ ok: false, reason: "conflict" });
  expect(result).not.toHaveProperty("receipt");
  expect(request.mock.calls).toEqual([["myself", "GET", undefined, "json"], ["filter/37", "GET", undefined, "json"]]);
});
it.each(FILTER_OWNER_CASES)("stops the $name readback at changed actor identity and retains its known target", async (scenario) => {
  const changed = object({ key: "another-key", name: "another-user" });
  const request = port([...scenario.before, scenario.ack, changed]);
  expect(await scenario.execute(scenario.args, request)).toMatchObject({ ok: false, reason: "conflict",
    receipt: { filterId: "37", userKey: "synthetic-key" } });
  expect(request.mock.calls.slice(scenario.before.length + 1)).toEqual([["myself", "GET", undefined, "json"]]);
  expect(request.mock.calls.filter(([, method]) => method !== "GET")).toHaveLength(1);
});
it.each(FILTER_OWNER_CASES)("keeps changed filter ownership after $name acknowledged and unconfirmed", async (scenario) => {
  const changed = object({ ...FILTER_BODY, owner: { key: "another-key", name: "another-user" } });
  const request = port([...scenario.before, scenario.ack, ACTOR, changed]);
  expect(await scenario.execute(scenario.args, request)).toMatchObject({ ok: false, reason: "conflict",
    receipt: { filterId: "37", userKey: "synthetic-key" } });
  expect(request.mock.calls.slice(scenario.before.length + 1)).toEqual([["myself", "GET", undefined, "json"], ["filter/37", "GET", undefined, "json"]]);
  expect(request.mock.calls.filter(([, method]) => method !== "GET")).toHaveLength(1);
});
it.each(FILTER_OWNER_CASES)("retains the $name receipt when the owned-filter read throws after ACK", async (scenario) => {
  const cause = new TypeError("Synthetic owned-filter read failure");
  const request = port([...scenario.before, scenario.ack, ACTOR, cause]);
  await expect(scenario.execute(scenario.args, request)).rejects.toMatchObject({ name: "JiraAcknowledgedMutationError", cause,
    receipt: { filterId: "37", userKey: "synthetic-key" } });
  expect(request.mock.calls.filter(([, method]) => method !== "GET")).toHaveLength(1);
});
it("refuses the last-moment default-sharing change before creation", async () => {
  const scenario = CASES[0];
  if (scenario === undefined) throw new TypeError("Missing create case");
  const request = port([ACTOR, PRIVATE, ACTOR, object({ scope: "GLOBAL" })]);
  expect(await scenario.execute(scenario.args, request)).toMatchObject({ ok: false, reason: "conflict" });
  expect(request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
});
it("retains a created ID when actual permissions contradict the reviewed private default", async () => {
  const scenario = CASES[0];
  if (scenario === undefined) throw new TypeError("Missing create case");
  const request = port([...scenario.before, scenario.ack, ACTOR, FILTER, list([GROUP])]);
  expect(await scenario.execute(scenario.args, request)).toMatchObject({ ok: false, receipt: { filterId: "37", defaultSharingAtomic: false } });
  expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
});
it("never uses a favourite collection or bare 404 to prove deletion", async () => {
  const request = port([ACTOR, FILTER, ACK, ACTOR, MISSING]);
  const result = await executeJiraFilterMutation("jira.delete-filter", REVIEWED, request);
  expect(result).toMatchObject({ ok: false, reason: "unavailable", receipt: { filterId: "37" } });
  expect(request.mock.calls.every(([path]) => path !== "filter/favourite")).toBe(true);
});
it("does not prove reset from a legacy array even when its values differ", async () => {
  const request = port([ACTOR, FILTER, COLUMNS, ACK, ACTOR, FILTER, list([{ value: "status" }])]);
  expect(await executeJiraFilterColumnMutation("jira.reset-filter-columns", COLUMN_INPUT, request)).toMatchObject({ ok: false, reason: "unavailable", receipt: { filterId: "37" } });
});
it("refuses stale complete permission snapshots before an effect", async () => {
  const request = port([ACTOR, FILTER, list([GROUP])]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [], permission: GROUP_TARGET }, request)).toMatchObject({ ok: false, reason: "conflict" });
  expect(request.mock.calls).toHaveLength(3);
});
it("requires explicit global replacement and verifies no old permissions survived", async () => {
  const args = { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [GROUP_ROW], permission: { type: "global", view: true, edit: false }, acceptGlobalReplacement: true };
  const request = port([ACTOR, FILTER, list([GROUP]), ACK, ACTOR, FILTER, list([{ id: 52, type: "global", view: true, edit: false }])]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", args, request)).toMatchObject({ ok: true, receipt: { filterId: "37", permissionId: "52" } });
  const noApproval = port([]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", { ...args, acceptGlobalReplacement: false }, noApproval)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(noApproval).not.toHaveBeenCalled();
});
it("never silently upgrades a recipient's existing rights", async () => {
  const request = port([ACTOR, FILTER, list([GROUP])]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [GROUP_ROW], permission: { ...GROUP_TARGET, edit: true } }, request)).toMatchObject({ ok: false, reason: "conflict" });
  expect(request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
});
it("binds user recipients by exact user key and reviewed native username", async () => {
  const args = { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [], permission: { type: "user", userKey: "recipient-key", expectedUsername: "recipient", view: true, edit: false } };
  const request = port([ACTOR, FILTER, list([]), object({ key: "different-key", name: "recipient" })]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", args, request)).toMatchObject({ ok: false, reason: "malformed-payload" });
  expect(request.mock.calls.at(-1)?.[0]).toBe("user?key=recipient-key");
});
it.each([
  ["jira.user.locale", "de_DE", ""], ["user.issues.per.page", 25, 0], ["user.notify.own.changes", true, false],
] as const)("preserves native empty/zero/false for %s", async (key, expectedValue, value) => {
  const request = port([ACTOR, scalar(String(expectedValue)), ACTOR, ACK, ACTOR, scalar(String(value))]);
  expect(await executeJiraPreferenceMutation("jira.set-my-preference", { key, expectedActorKey: "synthetic-key", expectedValue, value }, request)).toMatchObject({ ok: true });
  expect(request.mock.calls[3]).toEqual([`mypreferences?key=${key}`, "PUT", String(value), "none"]);
});
it.each(["jira.password", "jira.home", "constructor", "user.password"])("refuses non-allowlisted preference %s without native reads", async (key) => {
  const request = port([]);
  expect(await executeJiraPreferenceMutation("jira.set-my-preference", { key, expectedActorKey: "synthetic-key", expectedValue: "", value: "x" }, request)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(request).not.toHaveBeenCalled();
});
it("keeps the sole preference admission map immutable", () => {
  expect(Reflect.set(JIRA_NONSECRET_PREFERENCE_KINDS, "jira.password", "string")).toBe(false);
  expect(Object.hasOwn(JIRA_NONSECRET_PREFERENCE_KINDS, "jira.password")).toBe(false);
});
it("marks equal observed metadata, scope, preference and own layout as unchanged without effects", async () => {
  const filter = port([ACTOR, FILTER]);
  expect(await executeJiraFilterMutation("jira.update-filter", { ...REVIEWED, name: "Reviewed" }, filter)).toMatchObject({ ok: false, detail: { unchanged: true } });
  const scope = port([ACTOR, PRIVATE]);
  expect(await executeJiraFilterMutation("jira.set-filter-share-scope", { expectedActorKey: "synthetic-key", expectedScope: "PRIVATE", scope: "PRIVATE" }, scope)).toMatchObject({ ok: false, detail: { unchanged: true } });
  const preference = port([ACTOR, scalar("false")]);
  expect(await executeJiraPreferenceMutation("jira.set-my-preference", { key: "user.notify.own.changes", expectedActorKey: "synthetic-key", expectedValue: false, value: false }, preference)).toMatchObject({ ok: false, detail: { unchanged: true } });
  const columns = port([ACTOR, FILTER, COLUMNS]);
  expect(await executeJiraFilterColumnMutation("jira.set-filter-columns", { ...COLUMN_INPUT, columns: ["summary"] }, columns)).toMatchObject({ ok: false, detail: { unchanged: true } });
  for (const request of [filter, scope, preference, columns]) expect(request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
});
it("does not mistake an inherited matching layout for an unchanged explicit filter layout", async () => {
  const request = port([ACTOR, FILTER, object({ columnConfig: "SYSTEM", columnLayoutItems: [{ id: "summary" }] }), ACK, ACTOR, FILTER, COLUMNS]);
  expect(await executeJiraFilterColumnMutation("jira.set-filter-columns", { ...COLUMN_INPUT, expectedColumnConfig: "SYSTEM", columns: ["summary"] }, request)).toMatchObject({ ok: true });
  expect(request.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
});
it("retains a matching permission acknowledgement ID when its independent read is denied", async () => {
  const request = port([ACTOR, FILTER, list([]), object(GROUP, 201), DENIED]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [], permission: GROUP_TARGET }, request)).toMatchObject({ ok: false, reason: "permission-denied", receipt: { filterId: "37", permissionId: "51" } });
});
it("does not confirm a response with mixed recipient identity", async () => {
  const request = port([ACTOR, FILTER, list([]), ACK, ACTOR, FILTER, list([{ ...GROUP, user: { name: "other" } }])]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [], permission: GROUP_TARGET }, request)).toMatchObject({ ok: false, reason: "unavailable" });
});
it("refuses an oversized complete sharing list rather than using its first page", async () => {
  const request = port([ACTOR, FILTER, list(Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({ ...GROUP, id: index + 1 })))]);
  expect(await executeJiraFilterPermissionMutation("jira.add-filter-permission", { filterId: "37", expectedOwnerKey: "synthetic-key", expectedPermissions: [], permission: GROUP_TARGET }, request)).toMatchObject({ ok: false, reason: "bounds-exceeded" });
  expect(request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
});
it("refuses oversized column evidence before writing", async () => {
  const request = port([ACTOR, FILTER, list(Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, () => ({ value: "summary" })))]);
  expect(await executeJiraFilterColumnMutation("jira.reset-filter-columns", COLUMN_INPUT, request)).toMatchObject({ ok: false, reason: "bounds-exceeded" });
  expect(request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
});
it("preserves known targets when independent readback throws", async () => {
  const cause = new TypeError("Synthetic readback failure");
  const request = port([ACTOR, FILTER, ACK, cause]);
  const result = await executeJiraFilterMutation("jira.update-filter", { ...REVIEWED, name: "Changed" }, request).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(JiraAcknowledgedMutationError);
  expect(result).toMatchObject({ cause, receipt: { filterId: "37" } });
});
it("recognizes only closed fixed operations", () => {
  expect(isJiraFilterMutation("jira.create-filter")).toBe(true);
  expect(isJiraFilterColumnMutation("jira.reset-filter-columns")).toBe(true);
  expect(isJiraFilterPermissionMutation("jira.add-filter-permission")).toBe(true);
  expect(isJiraPreferenceMutation("jira.set-my-preference")).toBe(true);
  for (const guard of [isJiraFilterMutation, isJiraFilterColumnMutation, isJiraFilterPermissionMutation, isJiraPreferenceMutation]) expect(guard("constructor")).toBe(false);
});
