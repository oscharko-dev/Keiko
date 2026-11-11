import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { dispatchFailure, jiraFieldValidationFailure } from "./jira-mutation-failure.js";
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
export type LinkFailure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & {
  readonly receipt?: JiraLinkMutationReceipt;
};
export type JiraLinkMutationAttempt =
  LinkFailure | { readonly ok: true; readonly receipt: JiraLinkMutationReceipt };
export type LinkObservation<T> = LinkFailure | { readonly ok: true; readonly value: T };
export interface LinkIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
}
export const LINK_MALFORMED: LinkFailure = { ok: false, reason: "malformed-payload" };
export {
  jiraFieldValidationFailure as linkInvalid,
  jiraConflictFailure as linkConflict,
  jiraUnchangedFailure as linkUnchanged,
} from "./jira-mutation-failure.js";
export function linkActorInput(
  args: CatalogJsonObject,
  allowed: ReadonlySet<string>,
): args is CatalogJsonObject & { readonly expectedActorKey: string } {
  return savedExactKeys(args, allowed) && savedText(args.expectedActorKey, 255);
}
export async function bindLinkIssue(
  request: JiraMutationRequest,
  target: string,
  fields: readonly string[] = ["summary"],
): Promise<LinkObservation<LinkIssue>> {
  const issue = await readJiraMutationIssue(request, target, fields);
  if (!issue.ok) return issue;
  return jiraNativeId(issue.id) && isSafeAtlassianIdentifier(issue.key)
    ? { ok: true, value: { id: issue.id, key: issue.key, fields: issue.fields } }
    : LINK_MALFORMED;
}
export async function bindLinkActor(
  request: JiraMutationRequest,
  expectedActorKey: string,
): Promise<LinkObservation<true>> {
  const actor = await readSavedActor(request, expectedActorKey);
  return actor.ok ? { ok: true, value: true } : actor;
}
export function sameLinkParent(left: LinkIssue, right: LinkIssue): boolean {
  return left.id === right.id && left.key === right.key;
}
type LinkResponse = Awaited<ReturnType<JiraMutationRequest>>;
/** Either the refusal for a failed or non-2xx dispatched link write, or the acknowledged response. */
export function linkDispatchOutcome(
  response: LinkResponse,
  receipt: JiraLinkMutationReceipt,
):
  | { readonly refusal: JiraLinkMutationAttempt; readonly accepted?: undefined }
  | { readonly refusal?: undefined; readonly accepted: Extract<LinkResponse, { ok: true }> } {
  if (!response.ok) return { refusal: { ...dispatchFailure(response), receipt } };
  if (response.status < 200 || response.status >= 300)
    return { refusal: { ...LINK_MALFORMED, receipt } };
  return { accepted: response };
}
/** The shared select, admit, check, dispatch, acknowledge sequence of one native link write. */
export interface LinkMutationSteps<Input, State> {
  readonly selected: Input | undefined;
  readonly invalid: string;
  readonly admit: (selected: Input) => Promise<LinkObservation<State>>;
  readonly receiptFor: (selected: Input, state: State) => JiraLinkMutationReceipt;
  readonly dispatch: (selected: Input, state: State) => Promise<LinkResponse>;
  readonly settle: (
    selected: Input,
    state: State,
    receipt: JiraLinkMutationReceipt,
    accepted: Extract<LinkResponse, { ok: true }>,
  ) => Promise<JiraLinkMutationAttempt>;
}
export async function runLinkMutation<Input, State>(
  steps: LinkMutationSteps<Input, State>,
  check: boolean,
): Promise<JiraLinkMutationAttempt> {
  const { selected } = steps;
  if (selected === undefined) return jiraFieldValidationFailure(steps.invalid);
  const prior = await steps.admit(selected);
  if (!prior.ok) return prior;
  if (check) return { ok: true, receipt: {} };
  const receipt = steps.receiptFor(selected, prior.value);
  const outcome = linkDispatchOutcome(await steps.dispatch(selected, prior.value), receipt);
  if (outcome.refusal !== undefined) return outcome.refusal;
  return steps.settle(selected, prior.value, receipt, outcome.accepted);
}
