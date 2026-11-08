import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import type { JiraDirectoryAccessPorts } from "./jira-directory-access-request.js";
import { admitDirectoryRoles, bindDirectoryRoleGroups, bindDirectoryUser, projectDirectoryRoleConfiguration, readDirectoryColumns, readDirectoryRole, readDirectoryRoleCollection } from "./jira-directory-access-observations.js";
import { DIRECTORY_ACCESS_MALFORMED, directoryAccessReceipt, directoryAccessRefusal, parseDirectoryAccessInput, sameDirectoryColumns, sameDirectoryRole,
  type DirectoryAccessAttempt, type DirectoryAccessFailure, type DirectoryAccessInput, type DirectoryAccessObservation, type DirectoryAccessReceipt, type JiraDirectoryAccessMutation } from "./jira-directory-access-values.js";
export { JIRA_DIRECTORY_ACCESS_MUTATIONS, isJiraDirectoryAccessMutation, type JiraDirectoryAccessMutation } from "./jira-directory-access-values.js";

function unchanged(receipt: DirectoryAccessReceipt): DirectoryAccessFailure {
  return { ok: false, reason: "conflict", receipt, detail: { unchanged: true, messages: ["The exact reviewed configuration already equals the requested target. No native write was sent; effective permissions are not inferred."] } };
}
async function userAdmission(request: JiraMutationRequest, input: Exclude<DirectoryAccessInput, { kind: "roles" }>, receipt: DirectoryAccessReceipt): Promise<DirectoryAccessFailure | undefined> {
  const user = await bindDirectoryUser(request, input.user);
  if (user !== undefined) return user;
  if (input.kind === "application") {
    const role = await readDirectoryRole(request, input.role);
    return role.ok ? undefined : role;
  }
  const columns = await readDirectoryColumns(request, input.user.name);
  if (!columns.ok) return columns;
  if (!sameDirectoryColumns(columns.value, input.expected)) return directoryAccessRefusal("The user's complete ordered column sequence changed. Review the current sequence, including repetitions, before applying or resetting it.", "conflict");
  return input.kind === "columns" && sameDirectoryColumns(columns.value, input.columns) ? unchanged(receipt) : undefined;
}
async function roleAdmission(request: JiraMutationRequest, ports: JiraDirectoryAccessPorts, input: Extract<DirectoryAccessInput, { kind: "roles" }>, receipt: DirectoryAccessReceipt): Promise<DirectoryAccessFailure | undefined> {
  const current = await readDirectoryRoleCollection(ports);
  if (!current.ok) return current;
  const refused = admitDirectoryRoles(current.value, input);
  if (refused !== undefined) return refused;
  if (input.roles.every((role) => sameDirectoryRole(role.expected, role.value))) return unchanged(receipt);
  return bindDirectoryRoleGroups(request, input);
}
async function roleEffect(ports: JiraDirectoryAccessPorts, input: Extract<DirectoryAccessInput, { kind: "roles" }>): Promise<DirectoryAccessObservation<AtlassianWriteHttpOutcome>> {
  // Re-read collection and native version after group/actor admission. If it changes after this
  // read, native If-Match rejects it. A 412 never triggers a refresh-and-retry write.
  const current = await readDirectoryRoleCollection(ports);
  if (!current.ok) return current;
  const refused = admitDirectoryRoles(current.value, input);
  if (refused !== undefined) return refused;
  return { ok: true, value: await ports.roles.write(current.value.version, input.roles.map((role) => role.value), input.bulk) };
}
function userEffect(request: JiraMutationRequest, ports: JiraDirectoryAccessPorts, input: Exclude<DirectoryAccessInput, { kind: "roles" }>): Promise<AtlassianWriteHttpOutcome> {
  if (input.kind === "application") return ports.application(input.user.name, input.role.key, input.present);
  if (input.kind === "columns") return ports.columns(input.user.name, input.columns);
  return request(`user/columns?${new URLSearchParams({ username: input.user.name }).toString()}`, "DELETE", undefined, "none");
}
function acknowledgedFailure(failure: DirectoryAccessFailure, receipt: DirectoryAccessReceipt): DirectoryAccessFailure {
  return { ...failure, receipt, detail: { messages: ["Jira acknowledged the request, but its independent identity or configuration readback was unavailable or changed. The known receipt is retained; do not replay the request."] } };
}
async function confirmRoles(ports: JiraDirectoryAccessPorts, input: Extract<DirectoryAccessInput, { kind: "roles" }>, receipt: DirectoryAccessReceipt): Promise<DirectoryAccessAttempt> {
  const current = await readDirectoryRoleCollection(ports);
  if (!current.ok) return acknowledgedFailure(current, receipt);
  if (!input.roles.every((selected) => current.value.roles.some((role) => {
    const observed = projectDirectoryRoleConfiguration(role);
    return observed !== undefined && sameDirectoryRole(observed, selected.value);
  })))
    return directoryAccessRefusal("Jira acknowledged the role update, but the independently read selected configuration does not match. Do not replay.", "unavailable", receipt);
  return directoryAccessRefusal("Jira acknowledged and the requested role configuration was observed. This does not prove every user's application access, inherited group membership, license or permission consequence. The operation remains unconfirmed; do not replay.", "unavailable", receipt);
}
async function confirmUser(request: JiraMutationRequest, input: Exclude<DirectoryAccessInput, { kind: "roles" }>, receipt: DirectoryAccessReceipt): Promise<DirectoryAccessAttempt> {
  const user = await bindDirectoryUser(request, input.user);
  if (user !== undefined) return acknowledgedFailure(user, receipt);
  if (input.kind === "application") {
    const role = await readDirectoryRole(request, input.role);
    if (!role.ok) return acknowledgedFailure(role, receipt);
    return directoryAccessRefusal("Jira acknowledged the selected user's application change. Identity and role configuration were re-read, but no complete effective-access proof exists. The Boolean is the requested target only; do not replay.", "unavailable", receipt);
  }
  const columns = await readDirectoryColumns(request, input.user.name);
  if (!columns.ok) return acknowledgedFailure(columns, receipt);
  if (input.kind === "reset") return directoryAccessRefusal("Jira acknowledged the reset and the user's current columns were re-read. An array alone does not prove native fallback provenance or future inheritance from system defaults. The reset remains unconfirmed; do not replay.", "unavailable", receipt);
  return sameDirectoryColumns(columns.value, input.columns) ? { ok: true, receipt }
    : directoryAccessRefusal("Jira acknowledged the column change but the full ordered readback does not match. Do not replay.", "unavailable", receipt);
}
async function confirm(request: JiraMutationRequest, ports: JiraDirectoryAccessPorts, input: DirectoryAccessInput, receipt: DirectoryAccessReceipt): Promise<DirectoryAccessAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return acknowledgedFailure(actor, receipt);
  return input.kind === "roles" ? confirmRoles(ports, input, receipt) : confirmUser(request, input, receipt);
}
/** Exact user/role identities and bounded native CAS; no general HTTP or permission engine. */
export async function executeJiraDirectoryAccessMutation(operation: JiraDirectoryAccessMutation, args: CatalogJsonObject, request: JiraMutationRequest, ports: JiraDirectoryAccessPorts | undefined, check = false): Promise<DirectoryAccessAttempt> {
  const input = parseDirectoryAccessInput(operation, args);
  if (input === undefined) return directoryAccessRefusal("Review the exact actor, native role group/default-group sets, and separate target user key/username. Role/access changes require acceptGlobalPermissionChange:true. Column sequences are complete, ordered, nonempty and preserve repetitions. Missing/null sets are unavailable, never empty.");
  if (ports === undefined) return directoryAccessRefusal("The bound directory CAS/form/experimental transport is unavailable. No native request was sent.", "unavailable");
  const receipt = directoryAccessReceipt(input);
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 16384) return directoryAccessRefusal("The known directory target receipt exceeds the existing 16 KiB bound. Reduce the selection before any request.");
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  const refused = input.kind === "roles" ? await roleAdmission(request, ports, input, receipt) : await userAdmission(request, input, receipt);
  if (refused !== undefined) return refused;
  if (check) return { ok: true, receipt: {} };
  const reboundActor = await readSavedActor(request, input.actor);
  if (!reboundActor.ok) return reboundActor;
  const dispatched = input.kind === "roles" ? await roleEffect(ports, input)
    : { ok: true, value: await userEffect(request, ports, input) } as const;
  if (!dispatched.ok) return dispatched;
  const response = dispatched.value;
  if (!response.ok && input.kind === "roles" && response.httpStatus === 412)
    return directoryAccessRefusal("Jira rejected the stale native role version. Read and review the current group/default-group configuration before a new explicitly governed request. No refresh-and-retry was attempted.", "conflict", receipt);
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...DIRECTORY_ACCESS_MALFORMED, receipt };
  try { return await confirm(request, ports, input, receipt); }
  catch (error) { throw new JiraAcknowledgedMutationError(error, receipt); }
}
