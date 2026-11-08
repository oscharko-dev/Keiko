import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { bindIdentityUser, sameIdentityReview } from "./jira-identity-mutation-observations.js";
import { observedIdentityUser, type IdentityUserReview } from "./jira-identity-mutation-values.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor, type SavedActor } from "./jira-saved-configuration-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraPrivateIdentityPorts } from "./jira-private-identity-ports.js";
import {
  PRIVATE_ACCOUNT_MALFORMED,
  privateAccountFailure,
  privateAccountInput,
  privateAccountRefusal,
  privateValidationInput,
  type JiraPrivateAccountMutation,
  type JiraPrivateAccountRead,
  type JiraPrivateAccountReceipt,
  type PrivateAccountAttempt,
  type PrivateAccountFailure,
  type PrivateAccountInput,
  type PrivateAccountObservation,
  type PrivateValidationInput,
} from "./jira-private-account-values.js";
export {
  isJiraPrivateAccountMutation,
  isJiraPrivateAccountRead,
} from "./jira-private-account-values.js";

/** A private credential endpoint must never reflect remote password/license errors into tools. */
function privateFailure(
  response: Extract<AtlassianWriteHttpOutcome, { ok: false }>,
): PrivateAccountFailure {
  return { ok: false, reason: response.reason };
}
async function selfReview(
  request: JiraMutationRequest,
  expected: IdentityUserReview,
): Promise<PrivateAccountObservation<IdentityUserReview>> {
  const response = await request("myself", "GET", undefined, "json");
  if (!response.ok) return privateFailure(response);
  const value = response.status === 200 ? observedIdentityUser(response.body) : undefined;
  if (value === undefined) return PRIVATE_ACCOUNT_MALFORMED;
  return sameIdentityReview(value, expected)
    ? { ok: true, value }
    : privateAccountRefusal(
        "The current user's exact identity, display name or active state changed. Review the current native user before requesting a profile update.",
        "conflict",
      );
}
async function admit(
  request: JiraMutationRequest,
  input: PrivateAccountInput,
): Promise<PrivateAccountObservation<SavedActor>> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return privateAccountFailure(actor);
  if (input.kind === "session") return { ok: true, value: actor.value };
  if (input.kind === "profile") return admitProfile(request, input, actor.value);
  const user = await bindIdentityUser(request, input.user);
  if (!user.ok) return privateAccountFailure(user);
  if (input.self && (input.user.key !== actor.value.key || input.user.name !== actor.value.name))
    return privateAccountRefusal(
      "The reviewed password target is not the current connected user.",
      "conflict",
    );
  return { ok: true, value: actor.value };
}
async function admitProfile(
  request: JiraMutationRequest,
  input: Extract<PrivateAccountInput, { kind: "profile" }>,
  actor: SavedActor,
): Promise<PrivateAccountObservation<SavedActor>> {
  if (input.expected.key !== actor.key || input.expected.name !== actor.name)
    return privateAccountRefusal(
      "The connected actor and reviewed profile no longer identify the same native key and username.",
      "conflict",
    );
  const observed = await selfReview(request, input.expected);
  return observed.ok ? { ok: true, value: actor } : observed;
}
function receipt(input: PrivateAccountInput, actor: SavedActor): JiraPrivateAccountReceipt {
  const user = input.kind === "password" ? input.user : actor;
  return Object.freeze({ actorUserKey: actor.key, userKey: user.key, username: user.name });
}
function unconfirmed(known: JiraPrivateAccountReceipt): PrivateAccountAttempt {
  return {
    ...privateAccountRefusal(
      "Jira acknowledged the requested account/session operation. Its complete credential/session effects cannot be independently confirmed by this adapter. Known actor/target identities remain available; do not replay or silently reconnect after uncertainty.",
      "unavailable",
    ),
    receipt: known,
  };
}
function acknowledged(response: AtlassianWriteHttpOutcome): boolean {
  const status = response.ok ? response.status : response.httpStatus;
  return status !== undefined && status >= 200 && status < 300;
}
async function perform(
  input: PrivateAccountInput,
  ports: JiraPrivateIdentityPorts,
  known: JiraPrivateAccountReceipt,
): Promise<AtlassianWriteHttpOutcome> {
  try {
    if (input.kind === "profile")
      return await ports.perform("update-myself", { displayName: input.displayName });
    if (input.kind === "password")
      return await (input.self
        ? ports.perform("update-my-password", {})
        : ports.perform("update-user-password", { userKey: input.user.key }));
    return await (input.action === "login"
      ? ports.perform("login", {})
      : ports.session(input.action, input.actor));
  } catch (error) {
    // The private transport knows the actor, while this owner binds the exact target user.
    if (error instanceof JiraAcknowledgedMutationError)
      throw new JiraAcknowledgedMutationError(error, known);
    throw error;
  }
}
async function confirmProfile(
  request: JiraMutationRequest,
  input: Extract<PrivateAccountInput, { kind: "profile" }>,
  known: JiraPrivateAccountReceipt,
): Promise<PrivateAccountAttempt> {
  try {
    const after = await selfReview(request, { ...input.expected, displayName: input.displayName });
    return after.ok ? { ok: true, receipt: known } : { ...after, receipt: known };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, known);
  }
}
function confirmLogin(
  response: AtlassianWriteHttpOutcome,
  actor: SavedActor,
  known: JiraPrivateAccountReceipt,
): PrivateAccountAttempt {
  if (!response.ok || response.status !== 200) return unconfirmed(known);
  const body = response.body;
  return body?.sessionEstablished === true &&
    body.userKey === actor.key &&
    body.username === actor.name
    ? { ok: true, receipt: Object.freeze({ ...known, sessionEstablished: true }) }
    : unconfirmed(known);
}
export async function executeJiraPrivateAccountMutation(
  operation: JiraPrivateAccountMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraPrivateIdentityPorts | undefined,
  check = false,
): Promise<PrivateAccountAttempt> {
  const input = privateAccountInput(operation, args);
  if (input === undefined)
    return privateAccountRefusal(
      "Supply only the reviewed actor/user identity and supported public profile fields. Passwords, license text, cookies, input request IDs and credentials must use the existing protected human-input surface, never tool arguments.",
    );
  const admitted = await admit(request, input);
  if (!admitted.ok) return admitted;
  const known = receipt(input, admitted.value);
  if (input.kind === "profile" && input.expected.displayName === input.displayName)
    return {
      ok: false,
      reason: "conflict",
      receipt: known,
      detail: {
        unchanged: true,
        messages: [
          "The exact current display name already matches; no password input was consumed and no effect was dispatched.",
        ],
      },
    };
  if (check) return { ok: true, receipt: known };
  if (ports === undefined)
    return privateAccountRefusal(
      "The current operation has no server-bound protected input/session port. Submit input through the existing human-only surface; tool arguments cannot substitute for it.",
      "unavailable",
    );
  return dispatch(input, request, ports, known);
}
async function dispatch(
  input: PrivateAccountInput,
  request: JiraMutationRequest,
  ports: JiraPrivateIdentityPorts,
  known: JiraPrivateAccountReceipt,
): Promise<PrivateAccountAttempt> {
  const current = await admit(request, input);
  if (!current.ok) return current;
  const response = await perform(input, ports, known);
  if (!acknowledged(response))
    return response.ok
      ? { ...PRIVATE_ACCOUNT_MALFORMED, receipt: known }
      : { ...privateFailure(response), receipt: known };
  if (input.kind === "profile") return confirmProfile(request, input, known);
  return input.kind === "session" && input.action === "login"
    ? confirmLogin(response, current.value, known)
    : unconfirmed(known);
}
function validationFields(input: PrivateValidationInput): CatalogJsonObject {
  if (input.purpose === "validate-license") return {};
  if (input.purpose === "validate-update-user-password") return { username: input.user.name };
  return {
    username: input.username,
    displayName: input.displayName,
    emailAddress: input.emailAddress,
  };
}
async function validationAdmission(
  request: JiraMutationRequest,
  input: PrivateValidationInput,
): Promise<PrivateAccountFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return privateAccountFailure(actor);
  if (input.purpose !== "validate-update-user-password") return undefined;
  const user = await bindIdentityUser(request, input.user);
  return user.ok ? undefined : privateAccountFailure(user);
}
function validationScope(input: PrivateValidationInput): string {
  return input.purpose === "validate-license"
    ? "native-license-validation-only"
    : "native-password-policy-only";
}
function validationSubject(input: PrivateValidationInput): CatalogJsonObject {
  if (input.purpose === "validate-create-user-password") return { username: input.username };
  return input.purpose === "validate-update-user-password"
    ? { userKey: input.user.key, username: input.user.name }
    : {};
}
function validationResult(
  input: PrivateValidationInput,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
): ManagedMcpToolResult {
  const body = response.body;
  if (
    response.status !== 200 ||
    body === undefined ||
    typeof body.accepted !== "boolean" ||
    typeof body.violationCount !== "number"
  )
    return jiraReadFailure("malformed-payload");
  const count = body.violationCount;
  if (!Number.isSafeInteger(count) || count < 0 || count > TOOL_CATALOG_LIMITS.maxArrayItems)
    return jiraReadFailure("bounds-exceeded");
  if (body.accepted !== (count === 0)) return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      validationScope: validationScope(input),
      actorUserKey: input.actor,
      accepted: body.accepted,
      violationCount: count,
      ...validationSubject(input),
    },
  });
}
/** These three native POSTs validate only. They do not change a password, create a user, activate
 * a license or prove an old password. The private HTTP owner emits counts, never reflected input. */
export async function executeJiraPrivateAccountRead(
  operation: JiraPrivateAccountRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraPrivateIdentityPorts | undefined,
): Promise<ManagedMcpToolResult> {
  const input = privateValidationInput(operation, args);
  if (input === undefined) return jiraReadFailure("field-validation");
  const refused = await validationAdmission(request, input);
  if (refused !== undefined) return jiraReadFailure(refused.reason);
  if (ports === undefined) return jiraReadFailure("unavailable");
  const response = await ports.perform(input.purpose, validationFields(input));
  return response.ok ? validationResult(input, response) : jiraReadFailure(response.reason);
}
