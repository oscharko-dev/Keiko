import type { JiraMutationAttempt, JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { isSafeAtlassianAccountEmail } from "./atlassian-credential-custody.js";
import { jiraDirectoryUser } from "./jira-directory-values.js";
import { jiraPropertyPathKey } from "./jira-entity-property-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";

/** Local until the central identity tranche is approved. No password/license/session-token input. */
export const JIRA_IDENTITY_MUTATIONS = [
  "jira.create-user", "jira.update-user", "jira.delete-user", "jira.invalidate-user-session",
  "jira.schedule-user-anonymization", "jira.rerun-user-anonymization",
] as const;
export type JiraIdentityMutation = (typeof JIRA_IDENTITY_MUTATIONS)[number];
export interface JiraIdentityReceipt extends JiraMutationReceipt {
  readonly actorUserKey: string;
  readonly userKey?: string;
  readonly username?: string;
  readonly userPresent?: boolean;
  readonly userActive?: boolean;
  readonly userSessionInvalidationRequested?: true;
  readonly anonymizationRequested?: true;
  readonly anonymizationRerunRequested?: true;
  readonly newOwnerUserKey?: string;
}
export type IdentityFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & { readonly receipt?: JiraIdentityReceipt };
export type IdentityAttempt = IdentityFailure | { readonly ok: true; readonly receipt: JiraIdentityReceipt };
export type IdentityObservation<T> = IdentityFailure | { readonly ok: true; readonly value: T };
/** A prerequisite cannot supply this operation's receipt. Only its bound owner adds one. */
export function identityPrerequisiteFailure(failure: Extract<JiraMutationAttempt, { ok: false }>): IdentityFailure {
  return { ok: false, reason: failure.reason,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(failure.violations === undefined ? {} : { violations: failure.violations }) };
}
export interface IdentityUser { readonly key: string; readonly name: string }
export interface IdentityUserReview extends IdentityUser { readonly displayName: string; readonly active: boolean }
export interface JiraIdentityPorts {
  /** Fixed experimental UserResource methods only; provided by the bound server composition.
   * No password field, arbitrary query, route, header or alternate actor is accepted. */
  readonly user: (method: "POST" | "PUT" | "DELETE", key: string | undefined, body: CatalogJsonObject | undefined) => Promise<AtlassianWriteHttpOutcome>;
}
type Common = { readonly actor: string };
export type IdentityInput = Common & (
  | { readonly kind: "create"; readonly name: string; readonly email: string; readonly displayName: string }
  | { readonly kind: "update"; readonly expected: IdentityUserReview; readonly displayName?: string; readonly active?: boolean }
  | { readonly kind: "delete"; readonly expected: IdentityUserReview }
  | { readonly kind: "session"; readonly user: IdentityUser }
  | { readonly kind: "anonymize"; readonly rerun: boolean; readonly user: IdentityUser; readonly owner: IdentityUser;
      readonly operations: readonly string[]; readonly oldUserKey?: string; readonly oldUserName?: string }
);
export const IDENTITY_MALFORMED: IdentityFailure = { ok: false, reason: "malformed-payload" };
export function identityRefusal(message: string, reason: "field-validation" | "conflict" | "unavailable" = "field-validation", receipt?: JiraIdentityReceipt): IdentityFailure {
  return { ok: false, reason, detail: { messages: [message] }, ...(receipt === undefined ? {} : { receipt }) };
}
export function isJiraIdentityMutation(name: string): name is JiraIdentityMutation { return JIRA_IDENTITY_MUTATIONS.some((value) => value === name); }
const USER_KEYS = new Set(["key", "name"]);
const REVIEW_KEYS = new Set(["key", "name", "displayName", "active"]);
export function identityUser(value: unknown): IdentityUser | undefined {
  const raw = asRecord(value);
  return raw !== undefined && savedExactKeys(raw, USER_KEYS) && savedName(raw.key) && savedName(raw.name)
    ? Object.freeze({ key: raw.key, name: raw.name }) : undefined;
}
export function identityUserReview(value: unknown): IdentityUserReview | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, REVIEW_KEYS)) return undefined;
  const user = identityUser({ key: raw.key, name: raw.name });
  return user !== undefined && savedName(raw.displayName) && typeof raw.active === "boolean"
    ? Object.freeze({ ...user, displayName: raw.displayName, active: raw.active }) : undefined;
}
export function observedIdentityUser(value: unknown): IdentityUserReview | undefined {
  const user = jiraDirectoryUser(value);
  return user === undefined ? undefined : identityUserReview({ key: user.key, name: user.name, displayName: user.displayName, active: user.active });
}
const FIELDS: Readonly<Record<JiraIdentityMutation, ReadonlySet<string>>> = {
  "jira.create-user": new Set(["expectedActorKey", "name", "emailAddress", "displayName", "acceptGeneratedPassword", "acceptUnverifiedAccess"]),
  "jira.update-user": new Set(["expectedActorKey", "expectedUser", "displayName", "active", "acceptUnverifiedAccess"]),
  "jira.delete-user": new Set(["expectedActorKey", "expectedUser", "confirmIrreversibleDeletion"]),
  "jira.invalidate-user-session": new Set(["expectedActorKey", "user", "confirmSessionInvalidation"]),
  "jira.schedule-user-anonymization": new Set(["expectedActorKey", "user", "newOwner", "expectedOperations", "confirmIrreversibleAnonymization"]),
  "jira.rerun-user-anonymization": new Set(["expectedActorKey", "user", "newOwner", "expectedOperations", "confirmIrreversibleAnonymization", "oldUserKey", "oldUserName"]),
};
function createInput(args: CatalogJsonObject, actor: string): IdentityInput | undefined {
  return savedName(args.name) && savedName(args.displayName) && isSafeAtlassianAccountEmail(args.emailAddress) &&
    args.acceptGeneratedPassword === true && args.acceptUnverifiedAccess === true
    ? { kind: "create", actor, name: args.name, email: args.emailAddress, displayName: args.displayName } : undefined;
}
function reviewedInput(operation: JiraIdentityMutation, args: CatalogJsonObject, actor: string): IdentityInput | undefined {
  const expected = identityUserReview(args.expectedUser); if (expected === undefined) return undefined;
  if (operation === "jira.delete-user") return args.confirmIrreversibleDeletion === true ? { kind: "delete", actor, expected } : undefined;
  if (args.displayName === undefined && args.active === undefined) return undefined;
  if (args.displayName !== undefined && !savedName(args.displayName)) return undefined;
  if (args.active !== undefined && (typeof args.active !== "boolean" || args.acceptUnverifiedAccess !== true)) return undefined;
  return { kind: "update", actor, expected,
    ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
    ...(typeof args.active === "boolean" ? { active: args.active } : {}) };
}
function anonymizationInput(operation: JiraIdentityMutation, args: CatalogJsonObject, actor: string): IdentityInput | undefined {
  const user = identityUser(args.user); const owner = identityUser(args.newOwner); const operations = args.expectedOperations;
  if (user === undefined || owner === undefined || user.key === owner.key || args.confirmIrreversibleAnonymization !== true || !Array.isArray(operations) || operations.length === 0 ||
      operations.length > TOOL_CATALOG_LIMITS.maxArrayItems || !operations.every((item): item is string => savedText(item, 128)) || new Set(operations).size !== operations.length) return undefined;
  if (args.oldUserKey !== undefined && !savedName(args.oldUserKey)) return undefined;
  if (args.oldUserName !== undefined && !savedName(args.oldUserName)) return undefined;
  return { kind: "anonymize", actor, user, owner, operations: Object.freeze([...operations]), rerun: operation === "jira.rerun-user-anonymization",
    ...(typeof args.oldUserKey === "string" ? { oldUserKey: args.oldUserKey } : {}),
    ...(typeof args.oldUserName === "string" ? { oldUserName: args.oldUserName } : {}) };
}
export function parseIdentityInput(operation: JiraIdentityMutation, args: CatalogJsonObject): IdentityInput | undefined {
  if (!savedExactKeys(args, FIELDS[operation]) || !savedName(args.expectedActorKey) ||
      new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes) return undefined;
  const actor = args.expectedActorKey;
  if (operation === "jira.create-user") return createInput(args, actor);
  if (operation === "jira.update-user" || operation === "jira.delete-user") return reviewedInput(operation, args, actor);
  if (operation !== "jira.invalidate-user-session") return anonymizationInput(operation, args, actor);
  const user = identityUser(args.user);
  return user !== undefined && jiraPropertyPathKey(user.name) && args.confirmSessionInvalidation === true ? { kind: "session", actor, user } : undefined;
}
export function identityReceipt(input: IdentityInput, created?: IdentityUser): JiraIdentityReceipt {
  if (input.kind === "create") return { actorUserKey: input.actor, ...(created === undefined ? {} : { userKey: created.key, username: created.name }), userPresent: true };
  const user = input.kind === "update" || input.kind === "delete" ? input.expected : input.user;
  const receipt = { actorUserKey: input.actor, userKey: user.key, username: user.name };
  if (input.kind === "session") return { ...receipt, userSessionInvalidationRequested: true };
  if (input.kind === "anonymize") return { ...receipt, newOwnerUserKey: input.owner.key, anonymizationRequested: true,
    ...(input.rerun ? { anonymizationRerunRequested: true as const } : {}) };
  return { ...receipt, userPresent: input.kind !== "delete", ...(input.kind === "update" && input.active !== undefined ? { userActive: input.active } : {}) };
}
