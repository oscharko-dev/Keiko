import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  admitIdentityMutation,
  bindIdentityUser,
  createdIdentity,
} from "./jira-identity-mutation-observations.js";
import {
  IDENTITY_MALFORMED,
  identityPrerequisiteFailure,
  identityReceipt,
  identityRefusal,
  observedIdentityUser,
  parseIdentityInput,
  type IdentityAttempt,
  type IdentityFailure,
  type IdentityInput,
  type JiraIdentityMutation,
  type JiraIdentityPorts,
  type JiraIdentityReceipt,
} from "./jira-identity-mutation-values.js";
export {
  JIRA_IDENTITY_MUTATIONS,
  isJiraIdentityMutation,
  type JiraIdentityMutation,
} from "./jira-identity-mutation-values.js";

function usesUserPort(input: IdentityInput): boolean {
  return input.kind === "create" || input.kind === "update" || input.kind === "delete";
}
function unchanged(
  input: IdentityInput,
  receipt: JiraIdentityReceipt,
): IdentityFailure | undefined {
  if (
    input.kind !== "update" ||
    (input.displayName !== undefined && input.displayName !== input.expected.displayName) ||
    (input.active !== undefined && input.active !== input.expected.active)
  )
    return undefined;
  return {
    ok: false,
    reason: "conflict",
    receipt,
    detail: {
      unchanged: true,
      messages: [
        "The exact reviewed user fields already equal the requested values. No user update was sent.",
      ],
    },
  };
}
function userBody(input: Extract<IdentityInput, { kind: "create" | "update" }>): CatalogJsonObject {
  // Password is deliberately absent. Jira's native creation flow generates it; it is never read,
  // guessed, returned, logged, embedded in an approval or placed in model arguments.
  if (input.kind === "create")
    return { name: input.name, emailAddress: input.email, displayName: input.displayName };
  return {
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.active === undefined ? {} : { active: input.active }),
  };
}
function anonymizationBody(
  input: Extract<IdentityInput, { kind: "anonymize" }>,
): CatalogJsonObject {
  return {
    userKey: input.user.key,
    newOwnerKey: input.owner.key,
    ...(input.oldUserKey === undefined ? {} : { oldUserKey: input.oldUserKey }),
    ...(input.oldUserName === undefined ? {} : { oldUserName: input.oldUserName }),
  };
}
function effect(
  request: JiraMutationRequest,
  ports: JiraIdentityPorts | undefined,
  input: IdentityInput,
): Promise<AtlassianWriteHttpOutcome> {
  if (input.kind === "session")
    return request(
      `user/session/${encodeURIComponent(input.user.name)}`,
      "DELETE",
      undefined,
      "none",
    );
  if (input.kind === "anonymize")
    return request(
      `user/anonymization${input.rerun ? "/rerun" : ""}`,
      "POST",
      anonymizationBody(input),
      "none",
    );
  if (ports === undefined) return Promise.resolve({ ok: false, reason: "unavailable" });
  if (input.kind === "create") return ports.user("POST", undefined, userBody(input));
  return ports.user(
    input.kind === "update" ? "PUT" : "DELETE",
    input.expected.key,
    input.kind === "update" ? userBody(input) : undefined,
  );
}
function acknowledgedFailure(
  failure: IdentityFailure,
  receipt: JiraIdentityReceipt,
): IdentityFailure {
  return {
    ...failure,
    receipt,
    detail: {
      messages: [
        "Jira acknowledged the identity request, but an independent actor or user observation failed or changed. Keep the known target; do not replay or choose a same-name replacement.",
      ],
    },
  };
}
function unconfirmed(input: IdentityInput, receipt: JiraIdentityReceipt): IdentityFailure {
  const messages: Readonly<Record<IdentityInput["kind"], string>> = {
    create:
      "Jira acknowledged creation and the new native identity was read independently. Generated credentials, notifications, directory defaults and effective application access are not observable here. The aggregate result remains unconfirmed; do not create the account again.",
    update:
      "Jira acknowledged the update and the selected user fields were read independently. Active-state effects on every session, group, license and application are not proven. Keep the requested state distinct from effective access; do not replay.",
    delete:
      "Jira acknowledged deletion. Same-name users in another directory may shadow the deleted user and global references may remain. A 404, search prefix or different same-name user cannot prove complete deletion. The result remains unconfirmed; do not repeat the deletion.",
    session:
      "Jira acknowledged invalidation for the exact native username. No complete session inventory or browser-session binding proves that all sessions are gone, and the PAT is not a browser cookie. The requested invalidation remains unconfirmed; do not replay.",
    anonymize:
      "Jira accepted scheduling of the irreversible anonymization job. Extended validation and handlers may still fail; active-or-latest progress is not an independently bound task ID. No completion, global migration or ownership transfer is claimed. Review Jira's existing progress read and never automatically rerun this request.",
  };
  return identityRefusal(messages[input.kind], "unavailable", receipt);
}
function acknowledgedFieldsObserved(
  input: Extract<IdentityInput, { kind: "create" | "update" }>,
  observed: ReturnType<typeof observedIdentityUser>,
): boolean {
  const name =
    input.kind === "create" ? input.displayName : (input.displayName ?? input.expected.displayName);
  const active = input.kind === "update" ? (input.active ?? input.expected.active) : undefined;
  return observed?.displayName === name && (active === undefined || observed.active === active);
}
async function confirmUser(
  request: JiraMutationRequest,
  input: Extract<IdentityInput, { kind: "create" | "update" }>,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  receipt: JiraIdentityReceipt,
): Promise<IdentityAttempt> {
  const user =
    input.kind === "create" ? createdIdentity(response.body, input.name) : input.expected;
  if (user === undefined)
    return identityRefusal(
      "Jira acknowledged creation without the exact new native key/name. Do not guess the key, search by name to claim creation, or retry the POST.",
      "unavailable",
      receipt,
    );
  const known = input.kind === "create" ? identityReceipt(input, user) : receipt;
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return acknowledgedFailure(identityPrerequisiteFailure(actor), known);
  const current = await bindIdentityUser(request, user);
  if (!current.ok) return acknowledgedFailure(current, known);
  if (!acknowledgedFieldsObserved(input, observedIdentityUser(current.value)))
    return identityRefusal(
      "Jira acknowledged the request, but the same native user's independently read fields do not match. Keep the known identity and review it; do not replay.",
      "unavailable",
      known,
    );
  return input.kind === "update" && input.active === undefined
    ? { ok: true, receipt: known }
    : unconfirmed(input, known);
}
async function afterAcknowledgement(
  request: JiraMutationRequest,
  input: IdentityInput,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  receipt: JiraIdentityReceipt,
): Promise<IdentityAttempt> {
  if (input.kind === "create" || input.kind === "update")
    return confirmUser(request, input, response, receipt);
  // None of these endpoints supplies an independently attributable completion/absence proof.
  // In particular do not follow Location/cookie headers or turn a later 404 into confirmation.
  return unconfirmed(input, receipt);
}
function acknowledgedReceipt(
  input: IdentityInput,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  known: JiraIdentityReceipt,
): JiraIdentityReceipt {
  if (input.kind !== "create") return known;
  const created = createdIdentity(response.body, input.name);
  return created === undefined ? known : identityReceipt(input, created);
}
async function dispatchIdentity(
  request: JiraMutationRequest,
  ports: JiraIdentityPorts | undefined,
  input: IdentityInput,
  known: JiraIdentityReceipt,
): Promise<IdentityAttempt> {
  const response = await effect(request, ports, input);
  if (!response.ok) return { ...dispatchFailure(response), receipt: known };
  if (response.status < 200 || response.status >= 300)
    return { ...IDENTITY_MALFORMED, receipt: known };
  const acknowledged = acknowledgedReceipt(input, response, known);
  try {
    return await afterAcknowledgement(request, input, response, acknowledged);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, acknowledged);
  }
}
/** Fixed native identity operations over the existing custody/admission/ACK/journal owners. */
export async function executeJiraIdentityMutation(
  operation: JiraIdentityMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraIdentityPorts | undefined,
  check = false,
): Promise<IdentityAttempt> {
  const input = parseIdentityInput(operation, args);
  if (input === undefined)
    return identityRefusal(
      "Review the exact actor, native target identities and required observed fields. Passwords, licenses, cookies, tokens, arbitrary headers and transport URLs are not accepted. Creation requires explicit acknowledgement of Jira-generated credentials and unverified default access; irreversible changes require their specific confirmation.",
    );
  if (usesUserPort(input) && ports === undefined)
    return identityRefusal(
      "The bound fixed experimental UserResource transport is unavailable. No HTTP request was sent.",
      "unavailable",
    );
  const known = identityReceipt(input);
  const refused = await admitIdentityMutation(request, input);
  if (refused !== undefined) return refused;
  const noop = unchanged(input, known);
  if (noop !== undefined) return noop;
  if (check) return { ok: true, receipt: { actorUserKey: input.actor } };
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return identityPrerequisiteFailure(actor);
  return dispatchIdentity(request, ports, input, known);
}
