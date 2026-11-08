import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraDirectoryUser } from "./jira-directory-values.js";
import { bindJiraGroupPrincipal } from "./jira-group-principal.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { jiraRoleSummary } from "./jira-managed-role-reads.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import {
  jiraRoleReviewActors, jiraRoleReviewSnapshot, ROLE_MALFORMED, rolePrincipalText, roleRefusal,
  sameRole, sameRoleActors, type RoleActor, type RoleFailure, type RoleObservation,
  type RolePrincipals, type RoleSelection, type RoleSnapshot, type RoleUser,
} from "./jira-role-mutation-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";

export interface RoleContext {
  readonly role?: RoleSnapshot;
  readonly actors: readonly RoleActor[];
  readonly path: string;
  readonly projectId?: string;
  readonly projectKey?: string;
}
export async function readRole(request: JiraMutationRequest, id: string): Promise<RoleObservation<RoleSnapshot>> {
  const response = await request(`role/${id}`);
  if (!response.ok) return dispatchFailure(response);
  const role = response.status === 200 ? jiraRoleReviewSnapshot(response.body) : undefined;
  return role?.id === id ? { ok: true, value: role } : ROLE_MALFORMED;
}
function matchingActorEnvelope(body: Readonly<Record<string, unknown>> | undefined, role: RoleSnapshot, project: boolean): boolean {
  if (body === undefined) return false;
  if (project) { const actual = jiraRoleReviewSnapshot(body); return actual !== undefined && sameRole(actual, role); }
  // ProjectRoleActorsBean has only actors; do not require/invent role metadata in this envelope.
  return body.id === undefined || jiraNativeNumericId(body.id) === role.id;
}
export async function readRoleActors(request: JiraMutationRequest, path: string, role: RoleSnapshot, project = false): Promise<RoleObservation<readonly RoleActor[]>> {
  const response = await request(path);
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return ROLE_MALFORMED;
  if (!matchingActorEnvelope(response.body, role, project)) return roleRefusal("The selected role identity or project-role metadata does not match the independent native binding.", "conflict");
  const actors = jiraRoleReviewActors(response.body?.actors);
  return actors === undefined ? roleRefusal("The full actor list is unavailable or lacks native assignment IDs/types. Review a complete native role snapshot; missing facts are not empty membership.", "unavailable")
    : { ok: true, value: actors };
}
async function createContext(request: JiraMutationRequest, input: RoleSelection): Promise<RoleObservation<RoleContext>> {
  const response = await request("role", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return ROLE_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const ids = new Set<string>();
  for (const value of response.items) {
    const role = jiraRoleSummary(value);
    if (role === undefined || typeof role.id !== "string" || ids.has(role.id)) return ROLE_MALFORMED;
    ids.add(role.id);
    if (role.name === input.target?.name) return roleRefusal("A visible role already has the reviewed name. Inspect it rather than create a second role.", "conflict");
  }
  return { ok: true, value: { actors: [], path: "role" } };
}
async function projectContext(request: JiraMutationRequest, role: RoleSnapshot, target: string): Promise<RoleObservation<RoleContext>> {
  const bound = await readJiraBoundProject(request, target);
  if (!bound.ok) return bound;
  const { projectId, projectKey } = bound.project;
  const path = `project/${projectId}/role/${role.id}`;
  const actors = await readRoleActors(request, path, role, true);
  return actors.ok ? { ok: true, value: { role, actors: actors.value, path, projectId, projectKey } } : actors;
}
export async function readRoleContext(request: JiraMutationRequest, input: RoleSelection): Promise<RoleObservation<RoleContext>> {
  const actor = await readSavedActor(request, input.actorKey);
  if (!actor.ok) return actor;
  if (input.role === undefined) return createContext(request, input);
  const role = await readRole(request, input.role.id);
  if (!role.ok) return role;
  if (input.project !== undefined) return projectContext(request, role.value, input.project);
  const path = `role/${role.value.id}/actors`;
  const actors = await readRoleActors(request, path, role.value);
  return actors.ok ? { ok: true, value: { role: role.value, actors: actors.value, path } } : actors;
}
async function observedUser(request: JiraMutationRequest, selector: "username" | "key", target: string): Promise<RoleObservation<RoleUser>> {
  const response = await request(`user?${new URLSearchParams({ [selector]: target }).toString()}`);
  if (!response.ok) return dispatchFailure(response);
  const user = response.status === 200 ? jiraDirectoryUser(response.body) : undefined;
  return user !== undefined && rolePrincipalText(user.key) && rolePrincipalText(user.name)
    ? { ok: true, value: { key: user.key, name: user.name } } : ROLE_MALFORMED;
}
async function bindUser(request: JiraMutationRequest, expected: RoleUser): Promise<RoleFailure | undefined> {
  const named = await observedUser(request, "username", expected.name);
  if (!named.ok) return named;
  const keyed = await observedUser(request, "key", expected.key);
  if (!keyed.ok) return keyed;
  return [named.value, keyed.value].every((user) => user.key === expected.key && user.name === expected.name)
    ? undefined : roleRefusal("The reviewed user key and native username no longer identify the same user. No key/name fallback is permitted.", "conflict");
}
export async function bindRolePrincipals(request: JiraMutationRequest, selected: RolePrincipals): Promise<RoleFailure | undefined> {
  for (const user of selected.users) { const failure = await bindUser(request, user); if (failure !== undefined) return failure; }
  for (const name of selected.groups) { const failure = await bindJiraGroupPrincipal(request, name); if (failure !== undefined) return failure; }
  return undefined;
}
export async function bindSwap(request: JiraMutationRequest, input: RoleSelection): Promise<RoleFailure | undefined> {
  if (input.swap === undefined) return undefined;
  const role = await readRole(request, input.swap.role.id);
  if (!role.ok) return role;
  if (!sameRole(role.value, input.swap.role)) return roleRefusal("The reviewed replacement role changed.", "conflict");
  const actors = await readRoleActors(request, `role/${role.value.id}/actors`, role.value);
  if (!actors.ok) return actors;
  return sameRoleActors(actors.value, input.swap.actors) ? undefined
    : roleRefusal("The replacement role's complete default actor snapshot changed.", "conflict");
}
