import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import { savedText } from "./jira-saved-configuration-values.js";
import {
  bindLinkActor,
  bindLinkIssue,
  linkActorInput,
  linkConflict,
  runLinkMutation,
  linkUnchanged,
  LINK_MALFORMED,
  sameLinkParent,
  type JiraLinkMutationAttempt,
  type JiraLinkMutationReceipt,
  type LinkIssue,
  type LinkFailure,
  type LinkObservation,
} from "./jira-link-mutation-values.js";
import {
  projectRemoteLinkSnapshot,
  readCompleteRemoteLinks,
  remoteLinkBody,
  remoteLinkExpected,
  remoteLinkValue,
  sameRemoteLinks,
  sameRemoteLinkValue,
  type RemoteLinkSnapshot,
  type RemoteLinkValue,
} from "./jira-remote-link-mutation-values.js";

export const JIRA_REMOTE_LINK_MUTATIONS = [
  "jira.upsert-remote-link",
  "jira.update-remote-link",
  "jira.delete-remote-link",
  "jira.delete-remote-link-by-global-id",
] as const;
type Operation = (typeof JIRA_REMOTE_LINK_MUTATIONS)[number];
interface Input {
  readonly issue: string;
  readonly actorKey: string;
  readonly linkId?: string;
  readonly globalId?: string;
  readonly expected?: RemoteLinkSnapshot;
  readonly value?: RemoteLinkValue;
}
interface State {
  readonly issue: LinkIssue;
  readonly links: readonly RemoteLinkSnapshot[];
}
const FIELDS = new Set([
  "issueIdOrKey",
  "expectedActorKey",
  "linkId",
  "globalId",
  "expected",
  "expectAbsent",
  "value",
]);
function upsertInput(
  args: CatalogJsonObject,
  base: Pick<Input, "issue" | "actorKey">,
): Input | undefined {
  const value = remoteLinkValue(args.value);
  if (value === undefined) return undefined;
  if (value.globalId === null || args.linkId !== undefined || args.globalId !== undefined)
    return undefined;
  if (args.expectAbsent === true && args.expected === undefined)
    return { ...base, value, globalId: value.globalId };
  const expected = remoteLinkExpected(args.expected);
  return args.expectAbsent === undefined && expected?.globalId === value.globalId
    ? { ...base, value, expected, linkId: expected.id, globalId: value.globalId }
    : undefined;
}
function globalDeleteInput(
  args: CatalogJsonObject,
  base: Pick<Input, "issue" | "actorKey">,
  expected: RemoteLinkSnapshot,
): Input | undefined {
  return args.linkId === undefined &&
    args.value === undefined &&
    savedText(args.globalId, 255) &&
    expected.globalId === args.globalId
    ? { ...base, expected, linkId: expected.id, globalId: args.globalId }
    : undefined;
}
function selectedLinkInput(
  operation: Operation,
  args: CatalogJsonObject,
  base: Pick<Input, "issue" | "actorKey">,
  expected: RemoteLinkSnapshot,
): Input | undefined {
  if (!jiraNativeId(args.linkId) || args.linkId !== expected.id || args.globalId !== undefined)
    return undefined;
  if (operation === "jira.delete-remote-link")
    return args.value === undefined ? { ...base, expected, linkId: args.linkId } : undefined;
  const value = remoteLinkValue(args.value);
  return value === undefined ? undefined : { ...base, expected, value, linkId: args.linkId };
}
function input(operation: Operation, args: CatalogJsonObject): Input | undefined {
  if (!linkActorInput(args, FIELDS) || !isSafeAtlassianIdentifier(args.issueIdOrKey))
    return undefined;
  const base = { issue: args.issueIdOrKey, actorKey: args.expectedActorKey };
  if (operation === "jira.upsert-remote-link") return upsertInput(args, base);
  const expected = remoteLinkExpected(args.expected);
  if (expected === undefined || args.expectAbsent !== undefined) return undefined;
  return operation === "jira.delete-remote-link-by-global-id"
    ? globalDeleteInput(args, base, expected)
    : selectedLinkInput(operation, args, base, expected);
}
async function inspect(
  request: JiraMutationRequest,
  selected: Input,
): Promise<LinkObservation<State>> {
  const actor = await bindLinkActor(request, selected.actorKey);
  if (!actor.ok) return actor;
  const issue = await bindLinkIssue(request, selected.issue);
  if (!issue.ok) return issue;
  const links = await readCompleteRemoteLinks(request, issue.value);
  return links.ok ? { ok: true, value: { issue: issue.value, links: links.value } } : links;
}
function receiptFor(selected: Input, state: State): JiraLinkMutationReceipt {
  return {
    issueId: state.issue.id,
    issueKey: state.issue.key,
    userKey: selected.actorKey,
    linkPresent: selected.value !== undefined,
    ...(selected.linkId === undefined ? {} : { linkId: selected.linkId }),
  };
}
function replacementRefusal(
  selected: Input,
  state: State,
  current: RemoteLinkSnapshot,
): LinkFailure | undefined {
  const value = selected.value;
  if (value === undefined) return undefined;
  if (
    value.globalId !== null &&
    state.links.some((item) => item.id !== selected.linkId && item.globalId === value.globalId)
  )
    return linkConflict(
      "Another remote link already owns the requested global ID. Nothing was written.",
    );
  return sameRemoteLinkValue(current, value)
    ? linkUnchanged(
        "The exact remote link already has the reviewed replacement value. Nothing was written.",
        receiptFor(selected, state),
      )
    : undefined;
}
function beforeEffect(selected: Input, state: State): LinkFailure | undefined {
  const current = state.links.find((item) => item.id === selected.linkId);
  if (selected.expected === undefined)
    return state.links.some((item) => item.globalId === selected.globalId)
      ? linkConflict(
          "The reviewed absent global ID is now present. POST would replace that link; read and review its full value first.",
        )
      : undefined;
  if (current === undefined || !sameRemoteLinkValue(current, selected.expected))
    return linkConflict(
      "The exact remote link changed or is absent from the complete same-parent list. Review its complete value before changing it.",
    );
  return replacementRefusal(selected, state, current);
}
async function currentSingle(
  request: JiraMutationRequest,
  state: State,
  expected: RemoteLinkSnapshot,
): Promise<LinkObservation<true>> {
  const response = await request(`issue/${state.issue.id}/remotelink/${expected.id}`);
  if (!response.ok) return dispatchFailure(response);
  const item =
    response.status === 200 ? projectRemoteLinkSnapshot(response.body, state.issue) : undefined;
  return item?.id === expected.id && sameRemoteLinkValue(item, expected)
    ? { ok: true, value: true }
    : linkConflict("The selected remote link detail disagrees with the complete same-parent list.");
}
function changedState(
  selected: Input,
  prior: State,
  current: State,
  receipt: JiraLinkMutationReceipt,
): JiraLinkMutationAttempt {
  if (receipt.linkId === undefined)
    return {
      ok: false,
      reason: "unavailable",
      receipt,
      detail: {
        messages: [
          "Jira acknowledged the request without a new link ID. Creation remains unconfirmed; never infer identity from the title or replay POST.",
        ],
      },
    };
  const wanted = selected.value;
  const exact = current.links.find((item) => item.id === receipt.linkId);
  if (
    wanted === undefined
      ? exact !== undefined
      : exact === undefined || !sameRemoteLinkValue(exact, wanted)
  )
    return linkConflict(
      "The independently read native state did not confirm the exact requested remote-link replacement or removal. Do not replay.",
      receipt,
    );
  const retained = prior.links.filter((item) => item.id !== selected.linkId);
  const actual = current.links.filter((item) => item.id !== receipt.linkId);
  return sameRemoteLinks(retained, actual)
    ? { ok: true, receipt }
    : linkConflict(
        "Other remote links changed during the operation. The known ID is retained, but the full requested effect is not confirmed.",
        receipt,
      );
}
async function confirm(
  request: JiraMutationRequest,
  selected: Input,
  prior: State,
  receipt: JiraLinkMutationReceipt,
  mismatchedAck: boolean,
): Promise<JiraLinkMutationAttempt> {
  try {
    const current = await inspect(request, { ...selected, issue: prior.issue.id });
    if (!current.ok) return { ...current, receipt };
    if (!sameLinkParent(prior.issue, current.value.issue)) return { ...LINK_MALFORMED, receipt };
    const changed = changedState(selected, prior, current.value, receipt);
    if (!changed.ok) return changed;
    if (selected.value !== undefined && receipt.linkId !== undefined) {
      const observed = await currentSingle(request, current.value, {
        id: receipt.linkId,
        ...selected.value,
      });
      if (!observed.ok) return { ...observed, receipt };
    }
    return mismatchedAck
      ? linkConflict(
          "The acknowledgement named a different or pre-existing link ID. Independent reads cannot authorize a retarget; do not replay.",
          receipt,
        )
      : changed;
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
function dispatchPath(operation: Operation, selected: Input, state: State): string {
  const base = `issue/${state.issue.id}/remotelink`;
  if (operation === "jira.upsert-remote-link") return base;
  return operation === "jira.delete-remote-link-by-global-id"
    ? `${base}?${new URLSearchParams({ globalId: selected.globalId ?? "" }).toString()}`
    : `${base}/${selected.linkId ?? ""}`;
}
export function isJiraRemoteLinkMutation(name: string): name is Operation {
  return (JIRA_REMOTE_LINK_MUTATIONS as readonly string[]).includes(name);
}
async function admitRemoteLink(
  request: JiraMutationRequest,
  selected: Input,
  templates: JiraIssueTemplateSource | undefined,
): Promise<LinkObservation<State>> {
  const prior = await inspect(request, selected);
  if (!prior.ok) return prior;
  const refusal = beforeEffect(selected, prior.value);
  if (refusal !== undefined) return refusal;
  if (selected.expected !== undefined) {
    const single = await currentSingle(request, prior.value, selected.expected);
    if (!single.ok) return single;
  }
  const gate = await gateJiraMutationByTemplates({
    request,
    source: templates,
    operation: "edit",
    metadata: [],
    target: { issueKey: prior.value.issue.id },
    validated: { fields: {}, update: {} },
  });
  if (!gate.ok) return gate;
  const rechecked = await inspect(request, { ...selected, issue: prior.value.issue.id });
  if (!rechecked.ok) return rechecked;
  if (
    !sameLinkParent(prior.value.issue, rechecked.value.issue) ||
    !sameRemoteLinks(prior.value.links, rechecked.value.links)
  )
    return linkConflict(
      "The complete remote-link state changed during admission. No write was sent.",
    );
  return prior;
}
function dispatchRemoteLink(
  request: JiraMutationRequest,
  operation: Operation,
  selected: Input,
  state: State,
): ReturnType<JiraMutationRequest> {
  const post = operation === "jira.upsert-remote-link";
  const otherMethod = selected.value === undefined ? "DELETE" : "PUT";
  return request(
    dispatchPath(operation, selected, state),
    post ? "POST" : otherMethod,
    selected.value === undefined ? undefined : remoteLinkBody(selected.value),
    post ? "json" : "none",
  );
}
function acknowledgedTargetMismatch(
  id: string,
  body: Readonly<Record<string, unknown>> | undefined,
  selected: Input,
  prior: State,
): boolean {
  const changed =
    selected.linkId === undefined
      ? prior.links.some((item) => item.id === id)
      : selected.linkId !== id;
  if (changed) return true;
  const self = body?.self;
  return (
    self !== undefined &&
    self !== null &&
    !jiraResourceSelfMatches(self, `issue/${prior.issue.id}/remotelink/${id}`)
  );
}
function malformedAcknowledgedId(
  body: Readonly<Record<string, unknown>> | undefined,
  id: string | undefined,
): boolean {
  return body !== undefined && Object.hasOwn(body, "id") && id === undefined;
}
function remoteAcknowledgement(
  operation: Operation,
  selected: Input,
  prior: State,
  receipt: JiraLinkMutationReceipt,
  body: Readonly<Record<string, unknown>> | undefined,
): { readonly receipt: JiraLinkMutationReceipt; readonly mismatched: boolean } {
  if (operation !== "jira.upsert-remote-link") return { receipt, mismatched: false };
  const acknowledgedId = jiraNativeNumericId(body?.id);
  const known =
    selected.linkId === undefined && acknowledgedId !== undefined
      ? { ...receipt, linkId: acknowledgedId }
      : receipt;
  const mismatched =
    malformedAcknowledgedId(body, acknowledgedId) ||
    (acknowledgedId !== undefined &&
      acknowledgedTargetMismatch(acknowledgedId, body, selected, prior));
  return { receipt: known, mismatched };
}
/** Native POST is an explicitly reviewed upsert. No reciprocal endpoint or external HTTP request. */
export async function executeJiraRemoteLinkMutation(
  operation: Operation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<JiraLinkMutationAttempt> {
  return runLinkMutation(
    {
      selected: input(operation, args),
      invalid:
        "Review the exact native issue, connected actor and complete remote link value. POST requires globalId and either expectAbsent:true or the complete expected snapshot; update/delete require the exact existing snapshot. Every nullable replacement field must be explicit.",
      admit: (selected) => admitRemoteLink(request, selected, templates),
      receiptFor,
      dispatch: (selected, state) => dispatchRemoteLink(request, operation, selected, state),
      settle: (selected, state, receipt, accepted) => {
        const acknowledged = remoteAcknowledgement(
          operation,
          selected,
          state,
          receipt,
          accepted.body,
        );
        return confirm(request, selected, state, acknowledged.receipt, acknowledged.mismatched);
      },
    },
    check,
  );
}
