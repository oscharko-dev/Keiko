import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import {
  admitRoleMutation,
  desiredRoleActors,
  roleEffect,
  roleReceipt,
  roleTarget,
  sameRolePrincipalNames,
} from "./jira-role-mutation-admission.js";
import {
  bindRolePrincipals,
  bindSwap,
  readRoleContext,
  type RoleContext,
} from "./jira-role-mutation-observations.js";
import {
  parseRoleMutation,
  ROLE_MALFORMED,
  roleRefusal,
  sameRole,
  sameRoleActors,
  type JiraRoleMutation,
  type JiraRoleMutationReceipt,
  type RoleAttempt,
  type RoleSelection,
  type RoleSnapshot,
} from "./jira-role-mutation-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";

export { JIRA_ROLE_MUTATIONS, isJiraRoleMutation } from "./jira-role-mutation-values.js";
function unconfirmed(receipt: JiraRoleMutationReceipt, message: string): RoleAttempt {
  return roleRefusal(
    `${message} Keep the known IDs and do not automatically repeat this operation.`,
    "unavailable",
    receipt,
  );
}
async function confirmDeletion(
  request: JiraMutationRequest,
  input: RoleSelection,
  receipt: JiraRoleMutationReceipt,
): Promise<RoleAttempt> {
  const actor = await readSavedActor(request, input.actorKey);
  if (!actor.ok) return { ...actor, receipt };
  const replacement = await bindSwap(request, input);
  if (replacement !== undefined) return { ...replacement, receipt };
  const role = input.role;
  if (role === undefined) return { ...ROLE_MALFORMED, receipt };
  const response = await request(`role/${role.id}`);
  if (!response.ok && response.reason !== "not-found")
    return { ...dispatchFailure(response), receipt };
  return unconfirmed(
    receipt,
    "Jira acknowledged role deletion. A selected 404 or visible role-list omission cannot prove all role deletion or scheme-reference replacement effects.",
  );
}
function sameContext(before: RoleContext, after: RoleContext): boolean {
  return before.projectId === after.projectId && before.projectKey === after.projectKey;
}
function matchingConfiguration(
  before: RoleContext,
  after: RoleContext,
  expected: RoleSnapshot,
): boolean {
  return sameContext(before, after) && after.role !== undefined && sameRole(after.role, expected);
}
async function confirmActors(
  request: JiraMutationRequest,
  input: RoleSelection,
  before: RoleContext,
  after: RoleContext,
  receipt: JiraRoleMutationReceipt,
): Promise<RoleAttempt> {
  if (input.principals === undefined)
    return sameRoleActors(after.actors, before.actors)
      ? { ok: true, receipt }
      : unconfirmed(
          receipt,
          "The independent default actor list changed during the metadata operation.",
        );
  const principals = await bindRolePrincipals(request, input.principals);
  if (principals !== undefined) return { ...principals, receipt };
  return unconfirmed(
    receipt,
    actorsConfirmed(input, before, after)
      ? "Fresh native actor configuration matches the reviewed change, but effective group membership and permission consequences are not independently proven. Receipt principal arrays describe the requested change only."
      : "Fresh native actor configuration does not fully match the reviewed change. Partial permission effects remain possible.",
  );
}
function actorsConfirmed(input: RoleSelection, before: RoleContext, after: RoleContext): boolean {
  const desired = desiredRoleActors(input, before.actors);
  if (!sameRolePrincipalNames(after.actors, desired)) return false;
  // New assignments receive native IDs; all retained assignments must keep their observed IDs.
  return before.actors.every(
    (actor) =>
      !desired.some((item) => item.type === actor.type && item.name === actor.name) ||
      after.actors.some(
        (item) => item.id === actor.id && item.type === actor.type && item.name === actor.name,
      ),
  );
}
async function confirmConfiguration(
  request: JiraMutationRequest,
  input: RoleSelection,
  before: RoleContext,
  receipt: JiraRoleMutationReceipt,
  id: string,
): Promise<RoleAttempt> {
  const target = roleTarget(input, id);
  const expected = target ?? input.role;
  if (expected === undefined) return { ...ROLE_MALFORMED, receipt };
  const current = await readRoleContext(request, {
    ...input,
    role: expected,
    ...(before.projectId === undefined ? {} : { project: before.projectId }),
  });
  if (!current.ok) return { ...current, receipt };
  const after = current.value;
  if (!matchingConfiguration(before, after, expected))
    return unconfirmed(
      receipt,
      "The independent role/project metadata does not match the approved target.",
    );
  return confirmActors(request, input, before, after, receipt);
}
async function confirm(
  request: JiraMutationRequest,
  input: RoleSelection,
  context: RoleContext,
  receipt: JiraRoleMutationReceipt,
  id: string,
): Promise<RoleAttempt> {
  try {
    return input.operation === "jira.delete-role"
      ? await confirmDeletion(request, input, receipt)
      : await confirmConfiguration(request, input, context, receipt, id);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function write(
  request: JiraMutationRequest,
  input: RoleSelection,
  context: RoleContext,
): Promise<RoleAttempt> {
  const native = roleEffect(input, context);
  if (native === undefined) return ROLE_MALFORMED;
  const receipt = roleReceipt(input, context, input.role?.id);
  const response = await request(native.path, native.method, native.body, native.expect);
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  const id = input.role?.id ?? jiraNativeNumericId(response.body?.id);
  if (id === undefined) return { ...ROLE_MALFORMED, receipt };
  // For known targets a bodyless successful ACK is sufficient only to start independent reads.
  // Creation never obtains an ID from a name lookup, a location URL or a replayed POST.
  const known = roleReceipt(input, context, id);
  return confirm(request, input, context, known, id);
}
/** Fixed RoleResource/ProjectRoleResource methods. Both local admin scope and native permissions
 * remain mandatory; neither successful actor-list reads nor the local grant establishes rights.
 */
export async function executeJiraRoleMutation(
  operation: JiraRoleMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<RoleAttempt> {
  const input = parseRoleMutation(operation, args);
  if (input === undefined)
    return roleRefusal(
      "Review the connected actor, exact native role metadata and full actor assignment IDs/types. Supply explicit user key/name pairs or group names; project replacement uses complete users/groups arrays. Native PUT requires name and description; deletion requires explicit unverified-deletion acceptance. No arbitrary routing or principal namespace is allowed.",
    );
  const current = await admitRoleMutation(request, input);
  if (!current.ok) return current;
  return check ? { ok: true, receipt: {} } : write(request, input, current.value);
}
