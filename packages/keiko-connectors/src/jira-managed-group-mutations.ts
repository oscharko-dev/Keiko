import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  admitGroupMutation,
  bindMutationGroup,
  readGroupMutationMembership,
} from "./jira-group-mutation-observations.js";
import {
  GROUP_MUTATION_MALFORMED,
  groupMutationReceipt,
  groupMutationRefusal,
  parseGroupMutationInput,
  type GroupMutationAttempt,
  type GroupMutationInput,
  type JiraGroupMutation,
  type JiraGroupMutationReceipt,
} from "./jira-group-mutation-values.js";
export {
  JIRA_GROUP_MUTATIONS,
  isJiraGroupMutation,
  type JiraGroupMutation,
} from "./jira-group-mutation-values.js";

function effect(input: GroupMutationInput): {
  readonly path: string;
  readonly method: "POST" | "DELETE";
  readonly body?: CatalogJsonObject;
  readonly expect: "json" | "none";
} {
  if (input.kind === "create")
    return { path: "group", method: "POST", body: { name: input.name }, expect: "json" };
  const query = new URLSearchParams({ groupname: input.name });
  if (input.kind === "delete") {
    if (input.swap !== undefined) query.set("swapGroup", input.swap);
    return { path: `group?${query.toString()}`, method: "DELETE", expect: "none" };
  }
  if (input.present)
    return {
      path: `group/user?${query.toString()}`,
      method: "POST",
      body: { name: input.user.name },
      expect: "none",
    };
  query.set("username", input.user.name);
  return { path: `group/user?${query.toString()}`, method: "DELETE", expect: "none" };
}
async function confirm(
  request: JiraMutationRequest,
  input: GroupMutationInput,
  receipt: JiraGroupMutationReceipt,
): Promise<GroupMutationAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ...actor, receipt };
  if (input.kind === "delete")
    return groupMutationRefusal(
      "Jira acknowledged the group deletion. A deleted group cannot be rebound, and this observation cannot establish every permission, access or restriction-transfer consequence. Keep the known target receipt and do not replay the deletion.",
      "unavailable",
      receipt,
    );
  const group = await bindMutationGroup(request, input.name);
  if (group !== undefined) return { ...group, receipt };
  if (input.kind === "create") return { ok: true, receipt };
  const member = await readGroupMutationMembership(request, input);
  if (!member.ok) return { ...member, receipt };
  if (member.value !== input.present)
    return groupMutationRefusal(
      "Jira acknowledged the request, but the native group-and-subgroup observation did not match the requested target. Inherited membership cannot establish a direct-assignment failure. Keep the known identities and do not replay.",
      "unavailable",
      receipt,
    );
  return groupMutationRefusal(
    "Jira acknowledged the group change. Bounded group or direct-membership observations cannot prove every permission, application access, restriction-transfer or directory consequence. Keep the known target receipt and do not replay.",
    "unavailable",
    receipt,
  );
}
/** Fixed GroupResource operations, independently bound principal namespaces and one native effect. */
export async function executeJiraGroupMutation(
  operation: JiraGroupMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<GroupMutationAttempt> {
  const input = parseGroupMutationInput(operation, args);
  if (input === undefined)
    return groupMutationRefusal(
      "Use the exact actor key and native group name. Membership requires the exact user key and username, group-and-subgroup expectedObservedMembership and acceptGlobalPermissionChange:true. Deletion additionally requires confirmUnverifiedDeletion:true and an independently readable different optional swapGroupName. Group pickers or default/project-role membership cannot replace direct membership.",
    );
  const receipt = groupMutationReceipt(input);
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 16384)
    return groupMutationRefusal(
      "The known group target receipt exceeds the existing 16 KiB bound. No request was sent.",
    );
  const refused = await admitGroupMutation(request, input);
  if (refused !== undefined) return refused;
  if (check) return { ok: true, receipt: {} };
  const current = await admitGroupMutation(request, input);
  if (current !== undefined) return current;
  return dispatch(request, input, receipt);
}
async function dispatch(
  request: JiraMutationRequest,
  input: GroupMutationInput,
  receipt: JiraGroupMutationReceipt,
): Promise<GroupMutationAttempt> {
  const target = effect(input);
  const response = await request(target.path, target.method, target.body, target.expect);
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300)
    return { ...GROUP_MUTATION_MALFORMED, receipt };
  if (input.kind === "create" && response.body?.name !== input.name)
    return groupMutationRefusal(
      "Jira acknowledged creation without the exact requested native group name. Do not search by a display name or replay the creation.",
      "unavailable",
      receipt,
    );
  try {
    return await confirm(request, input, receipt);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
