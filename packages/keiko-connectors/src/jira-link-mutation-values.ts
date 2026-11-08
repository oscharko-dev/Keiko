import { isSafeAtlassianIdentifier, type JiraMutationAttempt, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraNativeId } from "./jira-native-values.js";
import { readSavedActor, savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

/** Private leaf receipt until the central operation contracts explicitly admit these fields. */
export interface JiraLinkMutationReceipt extends JiraMutationReceipt {
  readonly linkId?: string;
  readonly linkTypeId?: string;
  readonly linkedIssueId?: string;
  readonly linkedIssueKey?: string;
  readonly linkPresent?: boolean;
}
export type LinkFailure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & { readonly receipt?: JiraLinkMutationReceipt };
export type JiraLinkMutationAttempt = LinkFailure | { readonly ok: true; readonly receipt: JiraLinkMutationReceipt };
export type LinkObservation<T> = LinkFailure | { readonly ok: true; readonly value: T };
export interface LinkIssue { readonly id: string; readonly key: string; readonly fields: Readonly<Record<string, unknown>> }
export const LINK_MALFORMED: LinkFailure = { ok: false, reason: "malformed-payload" };
export function linkInvalid(message: string): LinkFailure {
  return { ok: false, reason: "field-validation", detail: { validation: "invalid-field", messages: [message] } };
}
export function linkConflict(message: string, receipt?: JiraLinkMutationReceipt): LinkFailure {
  return { ok: false, reason: "conflict", detail: { messages: [message] }, ...(receipt === undefined ? {} : { receipt }) };
}
export function linkUnchanged(message: string, receipt: JiraLinkMutationReceipt): LinkFailure {
  return { ok: false, reason: "conflict", detail: { unchanged: true, messages: [message] }, receipt };
}
export function linkActorInput(args: CatalogJsonObject, allowed: ReadonlySet<string>): args is CatalogJsonObject & { readonly expectedActorKey: string } {
  return savedExactKeys(args, allowed) && savedText(args.expectedActorKey, 255);
}
export async function bindLinkIssue(request: JiraMutationRequest, target: string, fields: readonly string[] = ["summary"]): Promise<LinkObservation<LinkIssue>> {
  const issue = await readJiraMutationIssue(request, target, fields);
  if (!issue.ok) return issue;
  return jiraNativeId(issue.id) && isSafeAtlassianIdentifier(issue.key)
    ? { ok: true, value: { id: issue.id, key: issue.key, fields: issue.fields } } : LINK_MALFORMED;
}
export async function bindLinkActor(request: JiraMutationRequest, expectedActorKey: string): Promise<LinkObservation<true>> {
  const actor = await readSavedActor(request, expectedActorKey);
  return actor.ok ? { ok: true, value: true } : actor;
}
export function sameLinkParent(left: LinkIssue, right: LinkIssue): boolean {
  return left.id === right.id && left.key === right.key;
}
