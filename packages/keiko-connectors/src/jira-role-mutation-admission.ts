import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { bindRolePrincipals, bindSwap, readRoleContext, type RoleContext } from "./jira-role-mutation-observations.js";
import {
  roleRefusal, sameRole, sameRoleActors, type JiraRoleMutationReceipt, type RoleActor,
  type RoleFailure, type RoleObservation, type RolePrincipals, type RoleSelection, type RoleSnapshot,
} from "./jira-role-mutation-values.js";

export function roleTarget(input: RoleSelection, id: string): RoleSnapshot | undefined {
  const name = input.target?.name ?? input.role?.name;
  const description = input.target?.description === undefined ? input.role?.description : input.target.description;
  return name === undefined || description === undefined ? undefined : { id, name, description };
}
function actorChange(input: RoleSelection): "add" | "replace" | "remove" {
  if (input.operation === "jira.set-project-role-actors") return "replace";
  return input.operation.startsWith("jira.delete-") ? "remove" : "add";
}
export function roleReceipt(input: RoleSelection, context: RoleContext, id?: string): JiraRoleMutationReceipt {
  const principals = input.principals;
  const scope: "role-defaults" | "project-membership" = input.project === undefined ? "role-defaults" : "project-membership";
  return Object.freeze({
    userKey: input.actorKey,
    ...(id === undefined ? {} : { roleId: id }),
    rolePresent: input.operation !== "jira.delete-role",
    ...(input.swap === undefined ? {} : { swapRoleId: input.swap.role.id }),
    ...(context.projectId === undefined || context.projectKey === undefined ? {} : { projectId: context.projectId, projectKey: context.projectKey }),
    ...(principals === undefined ? {} : {
      roleActorsScope: scope,
      actorChange: actorChange(input),
      actorUserKeys: Object.freeze(principals.users.map((user) => user.key)),
      actorGroupNames: Object.freeze([...principals.groups]),
    }),
  });
}
function principalNames(principals: RolePrincipals): readonly Pick<RoleActor, "type" | "name">[] {
  return [
    ...principals.users.map(({ name }) => ({ type: "atlassian-user-role-actor" as const, name })),
    ...principals.groups.map((name) => ({ type: "atlassian-group-role-actor" as const, name })),
  ];
}
export function desiredRoleActors(input: RoleSelection, before: readonly RoleActor[]): readonly Pick<RoleActor, "type" | "name">[] {
  const selected = input.principals;
  if (selected === undefined) return before;
  const names = principalNames(selected);
  if (input.operation === "jira.set-project-role-actors") return names;
  const included = (actor: Pick<RoleActor, "type" | "name">) => names.some((item) => item.type === actor.type && item.name === actor.name);
  if (input.operation.startsWith("jira.delete-")) return before.filter((actor) => !included(actor));
  return [...before, ...names.filter((item) => !before.some((actor) => actor.type === item.type && actor.name === item.name))];
}
export function sameRolePrincipalNames(left: readonly Pick<RoleActor, "type" | "name">[], right: readonly Pick<RoleActor, "type" | "name">[]): boolean {
  return left.length === right.length && left.every((actor) => right.some((item) => item.type === actor.type && item.name === actor.name));
}
function unchanged(input: RoleSelection, context: RoleContext): RoleFailure | undefined {
  if (input.role === undefined) return undefined;
  const target = input.target === undefined ? undefined : roleTarget(input, input.role.id);
  const equal = input.principals === undefined
    ? target !== undefined && sameRole(target, input.role)
    : sameRolePrincipalNames(context.actors, desiredRoleActors(input, context.actors));
  return equal ? { ok: false, reason: "conflict", receipt: roleReceipt(input, context, input.role.id),
    detail: { unchanged: true, messages: ["The reviewed role already has this exact requested configuration. Nothing was written; this does not establish effective permissions."] } } : undefined;
}
function reviewedContext(input: RoleSelection, context: RoleContext): RoleFailure | undefined {
  if (input.role === undefined) return undefined;
  if (context.role === undefined || !sameRole(context.role, input.role))
    return roleRefusal("The exact reviewed role metadata changed. Review its current ID, name and description before writing.", "conflict");
  if (input.expectedActors === undefined || !sameRoleActors(context.actors, input.expectedActors))
    return roleRefusal("The complete reviewed native actor assignments changed. Missing actor type or ID cannot establish a safe replacement.", "conflict");
  return undefined;
}
function receiptFits(input: RoleSelection, context: RoleContext): boolean {
  // Reserve the maximum native int64 ID before creation; selected labels never reach audit logs.
  const value = roleReceipt(input, context, input.role?.id ?? "9223372036854775807");
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16384;
}
export async function admitRoleMutation(request: JiraMutationRequest, input: RoleSelection): Promise<RoleObservation<RoleContext>> {
  const current = await readRoleContext(request, input);
  if (!current.ok) return current;
  if (!receiptFits(input, current.value)) return roleRefusal("The requested principal receipt exceeds the existing 16 KiB result bound. Select fewer principals before any write.");
  const reviewed = reviewedContext(input, current.value);
  if (reviewed !== undefined) return reviewed;
  const swap = await bindSwap(request, input);
  if (swap !== undefined) return swap;
  if (input.principals !== undefined) {
    const bound = await bindRolePrincipals(request, input.principals);
    if (bound !== undefined) return bound;
  }
  const noChange = unchanged(input, current.value);
  return noChange ?? current;
}
export interface RoleEffect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: CatalogJsonObject;
  readonly expect: "json" | "none";
}
function actorEffect(input: RoleSelection, context: RoleContext): RoleEffect | undefined {
  const selected = input.principals;
  if (selected === undefined || input.role === undefined) return undefined;
  const names = selected.users.map((user) => user.name);
  if (input.operation === "jira.set-project-role-actors") return {
    path: context.path, method: "PUT", expect: "none", body: { id: Number(input.role.id), categorisedActors: {
      "atlassian-user-role-actor": names, "atlassian-group-role-actor": selected.groups,
    } },
  };
  if (input.operation.startsWith("jira.delete-")) {
    const value = names[0] ?? selected.groups[0];
    if (value === undefined) return undefined;
    const query = new URLSearchParams({ [names.length === 1 ? "user" : "group"]: value });
    return { path: `${context.path}?${query.toString()}`, method: "DELETE", expect: "none" };
  }
  return { path: context.path, method: "POST", expect: "none", body: names.length > 0 ? { user: names } : { group: selected.groups } };
}
export function roleEffect(input: RoleSelection, context: RoleContext): RoleEffect | undefined {
  if (input.operation === "jira.create-role") return input.target === undefined ? undefined
    : { path: "role", method: "POST", body: { ...input.target }, expect: "json" };
  if (input.role === undefined) return undefined;
  const path = `role/${input.role.id}`;
  if (input.operation === "jira.delete-role") return { path: `${path}${input.swap === undefined ? "" : `?swap=${input.swap.role.id}`}`, method: "DELETE", expect: "none" };
  if (input.target !== undefined) return { path, method: input.operation === "jira.replace-role" ? "PUT" : "POST", body: { ...input.target }, expect: "none" };
  return actorEffect(input, context);
}
