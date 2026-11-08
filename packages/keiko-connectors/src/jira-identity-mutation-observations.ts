import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraDirectoryUser } from "./jira-directory-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readSavedActor, savedName } from "./jira-saved-configuration-values.js";
import { projectJiraAnonymizationValidation } from "./jira-managed-anonymization-reads.js";
import {
  IDENTITY_MALFORMED,
  identityPrerequisiteFailure,
  identityRefusal,
  identityUser,
  observedIdentityUser,
  type IdentityFailure,
  type IdentityInput,
  type IdentityObservation,
  type IdentityUser,
  type IdentityUserReview,
} from "./jira-identity-mutation-values.js";

async function readUser(
  request: JiraMutationRequest,
  selector: "key" | "username",
  value: string,
): Promise<IdentityObservation<CatalogJsonObject>> {
  const response = await request(
    `user?${new URLSearchParams({ [selector]: value }).toString()}`,
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return identityPrerequisiteFailure(dispatchFailure(response));
  const current = response.status === 200 ? jiraDirectoryUser(response.body) : undefined;
  return current !== undefined &&
    identityUser({ key: current.key, name: current.name }) !== undefined
    ? { ok: true, value: current }
    : IDENTITY_MALFORMED;
}
/** Neither key nor username is a fallback: both must independently identify the selected user. */
export async function bindIdentityUser(
  request: JiraMutationRequest,
  expected: IdentityUser,
): Promise<IdentityObservation<CatalogJsonObject>> {
  const named = await readUser(request, "username", expected.name);
  if (!named.ok) return named;
  const keyed = await readUser(request, "key", expected.key);
  if (!keyed.ok) return keyed;
  return [named.value, keyed.value].every(
    (user) => user.key === expected.key && user.name === expected.name && user.deleted !== true,
  )
    ? keyed
    : identityRefusal(
        "The exact reviewed user key and username no longer identify the same non-deleted user. Read both identities again; do not substitute a same-name user from another directory.",
        "conflict",
      );
}
export function sameIdentityReview(left: IdentityUserReview, right: IdentityUserReview): boolean {
  return (
    left.key === right.key &&
    left.name === right.name &&
    left.displayName === right.displayName &&
    left.active === right.active
  );
}
async function reviewedUser(
  request: JiraMutationRequest,
  expected: IdentityUserReview,
): Promise<IdentityFailure | undefined> {
  const selected = await bindIdentityUser(request, expected);
  if (!selected.ok) return selected;
  const observed = observedIdentityUser(selected.value);
  return observed !== undefined && sameIdentityReview(observed, expected)
    ? undefined
    : identityRefusal(
        "The user's reviewed display name, active state or exact identity changed or is unavailable. Missing fields are not defaults; review the current native user before a new request.",
        "conflict",
      );
}
export function identityValidationPath(
  input: Extract<IdentityInput, { kind: "anonymize" }>,
): string {
  const query = new URLSearchParams({ userKey: input.user.key });
  if (input.oldUserKey !== undefined) query.set("oldUserKey", input.oldUserKey);
  if (input.oldUserName !== undefined) query.set("oldUserName", input.oldUserName);
  return `user/anonymization${input.rerun ? "/rerun" : ""}?${query.toString()}`;
}
function emptyObserved(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}
type AnonymizeInput = Extract<IdentityInput, { kind: "anonymize" }>;
async function bindAnonymizationParties(
  request: JiraMutationRequest,
  input: AnonymizeInput,
): Promise<IdentityFailure | undefined> {
  const user = await bindIdentityUser(request, input.user);
  if (!user.ok) return user;
  const owner = await bindIdentityUser(request, input.owner);
  if (!owner.ok) return owner;
  return owner.value.active === true
    ? undefined
    : identityRefusal(
        "The selected ownership recipient must be independently observed as active. Unknown state is not an active account.",
      );
}
function anonymizationValidationRefusal(
  value: CatalogJsonObject,
  input: AnonymizeInput,
): IdentityFailure | undefined {
  if (
    value.userName !== input.user.name ||
    value.deleted !== false ||
    value.success !== true ||
    value.businessLogicValidationFailed !== false ||
    !emptyObserved(value.errors) ||
    !emptyObserved(value.warnings)
  )
    return identityRefusal(
      "Native anonymization validation must explicitly bind the reviewed user and report success, no business validation failure, and complete empty errors/warnings. Review or resolve native diagnostics in Jira first; missing facts are unavailable, never an empty validation.",
      "unavailable",
    );
  return anonymizationOperationsRefusal(value.operations, input);
}
function anonymizationOperationsRefusal(
  operations: unknown,
  input: AnonymizeInput,
): IdentityFailure | undefined {
  if (
    !Array.isArray(operations) ||
    operations.length !== input.operations.length ||
    new Set(operations).size !== operations.length ||
    !operations.every((item) => typeof item === "string" && input.operations.includes(item))
  )
    return identityRefusal(
      "The native anonymization handler set changed after review. Read the validation again and review the complete current operations before scheduling.",
      "conflict",
    );
  return undefined;
}
async function anonymizationAdmission(
  request: JiraMutationRequest,
  input: AnonymizeInput,
): Promise<IdentityFailure | undefined> {
  const parties = await bindAnonymizationParties(request, input);
  if (parties !== undefined) return parties;
  const response = await request(identityValidationPath(input), "GET", undefined, "json");
  if (!response.ok) return identityPrerequisiteFailure(dispatchFailure(response));
  if (response.status !== 200 || response.body === undefined) return IDENTITY_MALFORMED;
  const projected = projectJiraAnonymizationValidation(response.body, input.user.key);
  if (!projected.ok) return projected;
  return anonymizationValidationRefusal(projected.value, input);
}
export async function admitIdentityMutation(
  request: JiraMutationRequest,
  input: IdentityInput,
): Promise<IdentityFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return identityPrerequisiteFailure(actor);
  if (input.kind === "create") return undefined;
  if (input.kind === "update" || input.kind === "delete")
    return reviewedUser(request, input.expected);
  if (input.kind === "anonymize") return anonymizationAdmission(request, input);
  const user = await bindIdentityUser(request, input.user);
  return user.ok ? undefined : user;
}
/** A new native key must come from the acknowledgement, never a guessed username or search. */
export function createdIdentity(
  value: Readonly<Record<string, unknown>> | undefined,
  requestedName: string,
): IdentityUser | undefined {
  return value !== undefined && savedName(value.key) && value.name === requestedName
    ? { key: value.key, name: requestedName }
    : undefined;
}
