import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { gateJiraMutationByTemplates, type JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import { asRecord } from "./atlassian-sync-classify.js";
import { bindLinkActor, linkActorInput, linkConflict, linkInvalid, linkUnchanged, LINK_MALFORMED, sameLinkParent, type JiraLinkMutationAttempt, type JiraLinkMutationReceipt, type LinkFailure, type LinkObservation } from "./jira-link-mutation-values.js";
import { confirmIssueLinkIdentity, edgeFields, matchingIssueEdges, nativeLinkType, readIssueLinkState, readLinkType, sameIssueEdges, type IssueLinkState, type NativeLinkType } from "./jira-issue-link-mutation-state.js";

export const JIRA_ISSUE_LINK_MUTATIONS = ["jira.create-issue-link", "jira.delete-issue-link"] as const;
type Operation = (typeof JIRA_ISSUE_LINK_MUTATIONS)[number];
interface Input { readonly inward: string; readonly outward: string; readonly actorKey: string; readonly type: NativeLinkType; readonly linkId?: string }
interface State { readonly inward: IssueLinkState; readonly outward: IssueLinkState }
const FIELDS = new Set(["inwardIssueIdOrKey", "outwardIssueIdOrKey", "expectedActorKey", "linkType", "linkId"]);
function input(operation: Operation, args: CatalogJsonObject): Input | undefined {
  if (!linkActorInput(args, FIELDS) || !isSafeAtlassianIdentifier(args.inwardIssueIdOrKey) || !isSafeAtlassianIdentifier(args.outwardIssueIdOrKey)) return undefined;
  const raw = asRecord(args.linkType);
  const type = nativeLinkType(raw);
  if (type === undefined || raw === undefined || Object.keys(raw).some((key) => !["id", "name", "inward", "outward"].includes(key))) return undefined;
  const base = { inward: args.inwardIssueIdOrKey, outward: args.outwardIssueIdOrKey, actorKey: args.expectedActorKey, type };
  return operation === "jira.delete-issue-link" ? (jiraNativeId(args.linkId) ? { ...base, linkId: args.linkId } : undefined)
    : args.linkId === undefined ? base : undefined;
}
async function inspect(request: JiraMutationRequest, selected: Input): Promise<LinkObservation<State>> {
  const actor = await bindLinkActor(request, selected.actorKey);
  if (!actor.ok) return actor;
  const type = await readLinkType(request, selected.type);
  if (!type.ok) return type;
  const inward = await readIssueLinkState(request, selected.inward);
  if (!inward.ok) return inward;
  const outward = await readIssueLinkState(request, selected.outward);
  if (!outward.ok) return outward;
  return inward.value.issue.id === outward.value.issue.id ? linkInvalid("Select two different native issues for an issue link.")
    : { ok: true, value: { inward: inward.value, outward: outward.value } };
}
function receiptFor(selected: Input, state: State): JiraLinkMutationReceipt {
  return { issueId: state.inward.issue.id, issueKey: state.inward.issue.key, linkedIssueId: state.outward.issue.id, linkedIssueKey: state.outward.issue.key,
    linkTypeId: selected.type.id, userKey: selected.actorKey, linkPresent: selected.linkId === undefined,
    ...(selected.linkId === undefined ? {} : { linkId: selected.linkId }) };
}
function beforeEffect(selected: Input, state: State): LinkFailure | undefined {
  const forward = matchingIssueEdges(state.inward, state.outward.issue, selected.type, "outward");
  const reverse = matchingIssueEdges(state.outward, state.inward.issue, selected.type, "inward");
  if (selected.linkId !== undefined) return forward.some((item) => item.id === selected.linkId) && reverse.some((item) => item.id === selected.linkId) ? undefined
    : linkConflict("Both complete native issue relations must contain the exact reviewed link before deletion.");
  if (forward.length === 0 && reverse.length === 0) return undefined;
  const existing = forward.length === 1 ? forward[0] : undefined;
  if (existing !== undefined && reverse.length === 1 && existing.id === reverse[0]?.id)
    return linkUnchanged("This exact relation already exists on both issues. No duplicate was created.", { ...receiptFor(selected, state), linkId: existing.id });
  return linkConflict("The relation is duplicated or the two complete issue link lists disagree. Review the native relations before creating another link.");
}
async function templateAdmission(request: JiraMutationRequest, selected: Input, state: State, source: JiraIssueTemplateSource | undefined): Promise<LinkObservation<true>> {
  for (const [current, other, direction] of [[state.inward, state.outward, "outward"], [state.outward, state.inward, "inward"]] as const) {
    const retained = current.edges.filter((edge) => edge.id !== selected.linkId);
    const planned = selected.linkId === undefined
      ? [...edgeFields(retained), { type: { ...selected.type }, [`${direction}Issue`]: { id: other.issue.id, key: other.issue.key } }]
      : edgeFields(retained);
    const gate = await gateJiraMutationByTemplates({ request, source, operation: "edit", metadata: [], target: { issueKey: current.issue.id },
      validated: { fields: { issuelinks: planned }, update: {} }, plannedIssueLinks: planned });
    if (!gate.ok) return gate;
  }
  return { ok: true, value: true };
}
function sameState(left: State, right: State): boolean {
  return sameLinkParent(left.inward.issue, right.inward.issue) && sameLinkParent(left.outward.issue, right.outward.issue) &&
    sameIssueEdges(left.inward.edges, right.inward.edges) && sameIssueEdges(left.outward.edges, right.outward.edges);
}
function remainingMatches(before: State, after: State, linkId: string, deleting: boolean): boolean {
  return (["inward", "outward"] as const).every((side) => {
    const prior = deleting ? before[side].edges.filter((edge) => edge.id !== linkId) : before[side].edges;
    const current = deleting ? after[side].edges : after[side].edges.filter((edge) => edge.id !== linkId);
    return sameIssueEdges(prior, current);
  });
}
async function confirm(request: JiraMutationRequest, selected: Input, prior: State, receipt: JiraLinkMutationReceipt): Promise<JiraLinkMutationAttempt> {
  let known = receipt;
  try {
    const current = await inspect(request, { ...selected, inward: prior.inward.issue.id, outward: prior.outward.issue.id });
    if (!current.ok) return { ...current, receipt: known };
    if (!sameLinkParent(prior.inward.issue, current.value.inward.issue) || !sameLinkParent(prior.outward.issue, current.value.outward.issue)) return { ...LINK_MALFORMED, receipt: known };
    if (selected.linkId !== undefined) return remainingMatches(prior, current.value, selected.linkId, true)
      ? { ok: true, receipt: known } : linkConflict("The complete same-parent relations did not confirm removal of only the reviewed link. Do not replay.", known);
    const matches = matchingIssueEdges(current.value.inward, current.value.outward.issue, selected.type, "outward")
      .filter((edge) => !prior.inward.edges.some((old) => old.id === edge.id));
    const added = matches.length === 1 ? matches[0] : undefined;
    if (added === undefined) return linkConflict("The acknowledged creation has no unique new native relation in the complete issue list. Do not replay.", known);
    known = { ...known, linkId: added.id };
    const reverse = matchingIssueEdges(current.value.outward, current.value.inward.issue, selected.type, "inward");
    if (reverse.length !== 1 || reverse[0]?.id !== added.id || !remainingMatches(prior, current.value, added.id, false))
      return linkConflict("The new link ID is known, but both complete issue relations did not confirm the exact change. Do not replay.", known);
    const detail = await confirmIssueLinkIdentity(request, added.id, selected.type, current.value.inward.issue, current.value.outward.issue);
    return detail.ok ? { ok: true, receipt: known } : { ...detail, receipt: known };
  } catch (error) { throw new JiraAcknowledgedMutationError(error, known); }
}
export function isJiraIssueLinkMutation(name: string): name is Operation {
  return name === "jira.create-issue-link" || name === "jira.delete-issue-link";
}
/** One relation effect, with the same saved-template gate as ordinary issue edits. */
export async function executeJiraIssueLinkMutation(operation: Operation, args: CatalogJsonObject, request: JiraMutationRequest, check = false, templates?: JiraIssueTemplateSource): Promise<JiraLinkMutationAttempt> {
  const selected = input(operation, args);
  if (selected === undefined) return linkInvalid("Review both issues, the connected actor key and exact link type ID/name/inward/outward labels. Delete also requires the native link ID; optional comment side effects are unavailable.");
  const prior = await inspect(request, selected);
  if (!prior.ok) return prior;
  const refusal = beforeEffect(selected, prior.value);
  if (refusal !== undefined) return refusal;
  if (selected.linkId !== undefined) {
    const detail = await confirmIssueLinkIdentity(request, selected.linkId, selected.type, prior.value.inward.issue, prior.value.outward.issue);
    if (!detail.ok) return detail;
  }
  const gate = await templateAdmission(request, selected, prior.value, templates);
  if (!gate.ok) return gate;
  const rechecked = await inspect(request, { ...selected, inward: prior.value.inward.issue.id, outward: prior.value.outward.issue.id });
  if (!rechecked.ok) return rechecked;
  if (!sameState(prior.value, rechecked.value)) return linkConflict("The actor, issues or complete relation snapshot changed during admission. Nothing was written.");
  if (check) return { ok: true, receipt: {} };
  const receipt = receiptFor(selected, prior.value);
  const response = selected.linkId === undefined
    ? await request("issueLink", "POST", { type: { id: selected.type.id }, inwardIssue: { id: prior.value.inward.issue.id }, outwardIssue: { id: prior.value.outward.issue.id } }, "none")
    : await request(`issueLink/${selected.linkId}`, "DELETE", undefined, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...LINK_MALFORMED, receipt };
  return confirm(request, selected, prior.value, receipt);
}
