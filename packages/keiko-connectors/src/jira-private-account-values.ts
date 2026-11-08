import {
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  JIRA_READ_TOOL_FAMILIES,
  type JiraPrivateAccountMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { isSafeAtlassianAccountEmail } from "./atlassian-credential-custody.js";
import {
  identityUser,
  identityUserReview,
  type IdentityUser,
  type IdentityUserReview,
} from "./jira-identity-mutation-values.js";
import { savedName } from "./jira-saved-configuration-values.js";
export { JIRA_PRIVATE_ACCOUNT_MUTATIONS };
export type { JiraPrivateAccountMutation };
export const JIRA_PRIVATE_ACCOUNT_READS = JIRA_READ_TOOL_FAMILIES.privateAccount;
export type JiraPrivateAccountRead = (typeof JIRA_PRIVATE_ACCOUNT_READS)[number];
export interface JiraPrivateAccountReceipt extends JiraMutationReceipt {
  readonly actorUserKey: string;
  readonly userKey?: string;
  readonly username?: string;
  /** Only the private custody owner may establish this after cookie-only independent identity reads. */
  readonly sessionEstablished?: true;
}
export type PrivateAccountFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraPrivateAccountReceipt;
};
export type PrivateAccountAttempt =
  PrivateAccountFailure | { readonly ok: true; readonly receipt: JiraPrivateAccountReceipt };
export type PrivateAccountObservation<T> =
  PrivateAccountFailure | { readonly ok: true; readonly value: T };
interface Base {
  readonly actor: string;
}
export type PrivateAccountInput =
  | (Base & {
      readonly kind: "profile";
      readonly expected: IdentityUserReview;
      readonly displayName: string;
    })
  | (Base & { readonly kind: "password"; readonly self: boolean; readonly user: IdentityUser })
  | (Base & { readonly kind: "session"; readonly action: "login" | "logout" | "release-websudo" });
export type PrivateValidationInput =
  | (Base & {
      readonly purpose: "validate-create-user-password";
      readonly username: string;
      readonly displayName: string;
      readonly emailAddress: string;
    })
  | (Base & { readonly purpose: "validate-update-user-password"; readonly user: IdentityUser })
  | (Base & { readonly purpose: "validate-license" });
function exact(args: CatalogJsonObject, keys: readonly string[]): boolean {
  return Object.keys(args).every((key) => keys.includes(key));
}
function profile(args: CatalogJsonObject, actor: string): PrivateAccountInput | undefined {
  if (
    !exact(args, ["expectedActorKey", "expectedUser", "displayName"]) ||
    !savedName(args.displayName)
  )
    return undefined;
  const expected = identityUserReview(args.expectedUser);
  return expected?.key === actor
    ? { kind: "profile", actor, expected, displayName: args.displayName }
    : undefined;
}
function password(
  args: CatalogJsonObject,
  actor: string,
  self: boolean,
): PrivateAccountInput | undefined {
  if (!exact(args, ["expectedActorKey", "user"])) return undefined;
  const user = identityUser(args.user);
  return user !== undefined && (!self || user.key === actor)
    ? { kind: "password", actor, self, user }
    : undefined;
}
export function privateAccountInput(
  operation: JiraPrivateAccountMutation,
  args: CatalogJsonObject,
): PrivateAccountInput | undefined {
  if (!savedName(args.expectedActorKey)) return undefined;
  const actor = args.expectedActorKey;
  switch (operation) {
    case "jira.update-myself":
      return profile(args, actor);
    case "jira.update-my-password":
      return password(args, actor, true);
    case "jira.update-user-password":
      return password(args, actor, false);
    case "jira.login":
      return exact(args, ["expectedActorKey"])
        ? { kind: "session", actor, action: "login" }
        : undefined;
    case "jira.logout":
      return exact(args, ["expectedActorKey"])
        ? { kind: "session", actor, action: "logout" }
        : undefined;
    case "jira.release-websudo":
      return exact(args, ["expectedActorKey"])
        ? { kind: "session", actor, action: "release-websudo" }
        : undefined;
  }
}
function createValidation(
  args: CatalogJsonObject,
  actor: string,
): PrivateValidationInput | undefined {
  return exact(args, ["expectedActorKey", "username", "displayName", "emailAddress"]) &&
    savedName(args.username) &&
    savedName(args.displayName) &&
    isSafeAtlassianAccountEmail(args.emailAddress)
    ? {
        actor,
        purpose: "validate-create-user-password",
        username: args.username,
        displayName: args.displayName,
        emailAddress: args.emailAddress,
      }
    : undefined;
}
export function privateValidationInput(
  operation: JiraPrivateAccountRead,
  args: CatalogJsonObject,
): PrivateValidationInput | undefined {
  if (!savedName(args.expectedActorKey)) return undefined;
  const actor = args.expectedActorKey;
  if (operation === "jira.validate-create-user-password") return createValidation(args, actor);
  if (operation === "jira.validate-license")
    return exact(args, ["expectedActorKey"]) ? { actor, purpose: "validate-license" } : undefined;
  const user = identityUser(args.user);
  return exact(args, ["expectedActorKey", "user"]) && user !== undefined
    ? { actor, purpose: "validate-update-user-password", user }
    : undefined;
}
export const PRIVATE_ACCOUNT_MALFORMED: PrivateAccountFailure = {
  ok: false,
  reason: "malformed-payload",
};
export function privateAccountFailure(
  value: Pick<PrivateAccountFailure, "reason" | "detail">,
): PrivateAccountFailure {
  return {
    ok: false,
    reason: value.reason,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}
export function privateAccountRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
): PrivateAccountFailure {
  return { ok: false, reason, detail: { messages: [message] } };
}
export function isJiraPrivateAccountMutation(name: string): name is JiraPrivateAccountMutation {
  return (JIRA_PRIVATE_ACCOUNT_MUTATIONS as readonly string[]).includes(name);
}
export function isJiraPrivateAccountRead(name: string): name is JiraPrivateAccountRead {
  return (JIRA_PRIVATE_ACCOUNT_READS as readonly string[]).includes(name);
}
