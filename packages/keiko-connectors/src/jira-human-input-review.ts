import { canonicalAtlassianConnectorBaseUrl, copyJiraHumanInputReview, type JiraHumanInputPurpose, type JiraHumanInputReview } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { bindIdentityUser } from "./jira-identity-mutation-observations.js";
import type { IdentityUser } from "./jira-identity-mutation-values.js";
import { privateAccountInput, privateValidationInput, type PrivateAccountInput, type PrivateValidationInput } from "./jira-private-account-values.js";
import { anonymizationUnlockInput } from "./jira-anonymization-unlock-values.js";
import { projectJiraAnonymizationTaskSnapshot } from "./jira-managed-anonymization-reads.js";
import { readSavedActor, type SavedActor } from "./jira-saved-configuration-values.js";

type Target =
  | { readonly kind: "user"; readonly user: IdentityUser }
  | { readonly kind: "actor" }
  | { readonly kind: "proposed-user"; readonly username: string }
  | { readonly kind: "instance" }
  | { readonly kind: "task"; readonly expected: CatalogJsonObject };
interface Selection { readonly actor: string; readonly target: Target }
function accountSelection(input: PrivateAccountInput | undefined): Selection | undefined {
  if (input === undefined) return undefined;
  return { actor: input.actor, target: input.kind === "password" ? { kind: "user", user: input.user } : { kind: "actor" } };
}
function validationSelection(input: PrivateValidationInput | undefined): Selection | undefined {
  if (input === undefined) return undefined;
  return { actor: input.actor, target: input.purpose === "validate-license" ? { kind: "instance" } :
    input.purpose === "validate-create-user-password" ? { kind: "proposed-user", username: input.username } : { kind: "user", user: input.user } };
}
function unlockSelection(args: CatalogJsonObject): Selection | undefined {
  const input = anonymizationUnlockInput(args);
  return input === undefined ? undefined : { actor: input.actor, target: { kind: "task", expected: input.expectedTask } };
}
function selected(purpose: JiraHumanInputPurpose, args: CatalogJsonObject): Selection | undefined {
  switch (purpose) {
    case "login": case "update-myself": case "update-my-password": case "update-user-password":
      return accountSelection(privateAccountInput(`jira.${purpose}`, args));
    case "validate-create-user-password": case "validate-update-user-password": case "validate-license":
      return validationSelection(privateValidationInput(`jira.${purpose}`, args));
    case "unlock-user-anonymization": return unlockSelection(args);
  }
}
async function observedTarget(target: Target, actor: SavedActor, request: JiraMutationRequest): Promise<CatalogJsonObject | undefined> {
  if (target.kind === "instance") return { targetKind: "instance" };
  if (target.kind === "proposed-user") return { targetKind: "proposed-user", targetUsername: target.username };
  if (target.kind === "actor") return { targetKind: "user", targetUserKey: actor.key, targetUsername: actor.name };
  if (target.kind === "task") return observedTask(target.expected, request);
  const bound = await bindIdentityUser(request, target.user);
  if (!bound.ok || typeof bound.value.key !== "string" || typeof bound.value.name !== "string") return undefined;
  return { targetKind: "user", targetUserKey: bound.value.key, targetUsername: bound.value.name };
}
async function observedTask(expected: CatalogJsonObject, request: JiraMutationRequest): Promise<CatalogJsonObject | undefined> {
  const response = await request("user/anonymization/progress", "GET", undefined, "json");
  const snapshot = response.ok && response.status === 200 ? projectJiraAnonymizationTaskSnapshot(response.body) : undefined;
  return snapshot !== undefined && typeof snapshot.userKey === "string" && typeof snapshot.executingNode === "string" && canonicalise(snapshot) === canonicalise(expected)
    ? { targetKind: "anonymization-task", targetUserKey: snapshot.userKey, executingNode: snapshot.executingNode } : undefined;
}
/** The caller supplies its current saved credential URL, never a model field. Existing native
 * identity readers bind user key and username independently before a human is asked for a secret.
 * The caller must recheck its authority/credential snapshot after awaiting these prerequisite GETs. */
export async function prepareJiraHumanInputReview(purpose: JiraHumanInputPurpose, args: CatalogJsonObject,
  credentialBaseUrl: string, request: JiraMutationRequest): Promise<JiraHumanInputReview | undefined> {
  const jiraBaseUrl = canonicalAtlassianConnectorBaseUrl(credentialBaseUrl);
  if (jiraBaseUrl === undefined) return undefined;
  const input = selected(purpose, args); if (input === undefined) return undefined;
  const actor = await readSavedActor(request, input.actor); if (!actor.ok) return undefined;
  const target = await observedTarget(input.target, actor.value, request); if (target === undefined) return undefined;
  return copyJiraHumanInputReview({ jiraBaseUrl, actorUserKey: actor.value.key,
    actorUsername: actor.value.name, ...target }, purpose);
}
