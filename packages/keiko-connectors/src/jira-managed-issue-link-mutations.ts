import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import { asRecord } from "./atlassian-sync-classify.js";
import {
  bindLinkActor,
  linkActorInput,
  linkConflict,
  runLinkMutation,
  linkInvalid,
  linkUnchanged,
  LINK_MALFORMED,
  sameLinkParent,
  type JiraLinkMutationAttempt,
  type JiraLinkMutationReceipt,
  type LinkFailure,
  type LinkObservation,
} from "./jira-link-mutation-values.js";
import {
  confirmIssueLinkIdentity,
  edgeFields,
  matchingIssueEdges,
  nativeLinkType,
  readIssueLinkState,
  readLinkType,
  sameIssueEdges,
  type IssueLinkState,
  type NativeIssueEdge,
  type NativeLinkType,
} from "./jira-issue-link-mutation-state.js";

export const JIRA_ISSUE_LINK_MUTATIONS = [
  "jira.create-issue-link",
  "jira.delete-issue-link",
] as const;
type Operation = (typeof JIRA_ISSUE_LINK_MUTATIONS)[number];
interface Input {
  readonly inward: string;
  readonly outward: string;
  readonly actorKey: string;
  readonly type: NativeLinkType;
  readonly linkId?: string;
}
interface State {
  readonly inward: IssueLinkState;
  readonly outward: IssueLinkState;
}
const FIELDS = new Set([
  "inwardIssueIdOrKey",
  "outwardIssueIdOrKey",
  "expectedActorKey",
  "linkType",
  "linkId",
]);
const LINK_ARGUMENTS = [...FIELDS].join(", ");
const LINK_TYPE_KEYS: ReadonlySet<string> = new Set(["id", "name", "inward", "outward"]);
type IssueLinkCheck =
  { readonly ok: true; readonly input: Input } | { readonly ok: false; readonly message: string };
const refused = (message: string): IssueLinkCheck => ({ ok: false, message });
/**
 * The input of one issue-link write, or the first rule it breaks as one sentence for the model
 * (#4357 AC3). The checks and the sentences are one function, so the order of the causes is the order
 * of the validation and a check added later cannot be left without its sentence. No value the model
 * sent is echoed.
 */
/** The link type when it is exactly the four fields of one type, and nothing else. */
function closedLinkType(value: unknown): NativeLinkType | undefined {
  const raw = asRecord(value);
  return raw !== undefined && Object.keys(raw).every((key) => LINK_TYPE_KEYS.has(key))
    ? nativeLinkType(raw)
    : undefined;
}
function checkIssueLinkInput(operation: Operation, args: CatalogJsonObject): IssueLinkCheck {
  if (Object.keys(args).some((key) => !FIELDS.has(key)))
    return refused(`This call takes only ${LINK_ARGUMENTS}.`);
  if (!linkActorInput(args, FIELDS))
    return refused(
      "expectedActorKey must be the key of the connected Jira user; jira.myself returns it.",
    );
  if (
    !isSafeAtlassianIdentifier(args.inwardIssueIdOrKey) ||
    !isSafeAtlassianIdentifier(args.outwardIssueIdOrKey)
  )
    return refused(
      "inwardIssueIdOrKey and outwardIssueIdOrKey must each be the key or id of one issue.",
    );
  const type = closedLinkType(args.linkType);
  if (type === undefined)
    return refused(
      "linkType must be exactly { id, name, inward, outward } of one type, as jira.link-types lists it.",
    );
  const base = {
    inward: args.inwardIssueIdOrKey,
    outward: args.outwardIssueIdOrKey,
    actorKey: args.expectedActorKey,
    type,
  };
  if (operation === "jira.delete-issue-link")
    return jiraNativeId(args.linkId)
      ? { ok: true, input: { ...base, linkId: args.linkId } }
      : refused("A delete takes linkId: the numeric ID of the link to delete.");
  return args.linkId === undefined
    ? { ok: true, input: base }
    : refused("A create takes no linkId: Jira assigns it.");
}
function invalidMessage(operation: Operation, args: CatalogJsonObject): string {
  const checked = checkIssueLinkInput(operation, args);
  return checked.ok ? "" : checked.message;
}
function input(operation: Operation, args: CatalogJsonObject): Input | undefined {
  const checked = checkIssueLinkInput(operation, args);
  return checked.ok ? checked.input : undefined;
}
async function inspect(
  request: JiraMutationRequest,
  selected: Input,
  preDispatch = false,
): Promise<LinkObservation<State>> {
  const actor = await bindLinkActor(request, selected.actorKey, preDispatch);
  if (!actor.ok) return actor;
  const type = await readLinkType(request, selected.type);
  if (!type.ok) return type;
  const inward = await readIssueLinkState(request, selected.inward);
  if (!inward.ok) return inward;
  const outward = await readIssueLinkState(request, selected.outward);
  if (!outward.ok) return outward;
  return inward.value.issue.id === outward.value.issue.id
    ? linkInvalid("Select two different native issues for an issue link.")
    : { ok: true, value: { inward: inward.value, outward: outward.value } };
}
function receiptFor(selected: Input, state: State): JiraLinkMutationReceipt {
  return {
    issueId: state.inward.issue.id,
    issueKey: state.inward.issue.key,
    linkedIssueId: state.outward.issue.id,
    linkedIssueKey: state.outward.issue.key,
    linkTypeId: selected.type.id,
    userKey: selected.actorKey,
    linkPresent: selected.linkId === undefined,
    ...(selected.linkId === undefined ? {} : { linkId: selected.linkId }),
  };
}
function existingLinkId(
  forward: readonly NativeIssueEdge[],
  reverse: readonly NativeIssueEdge[],
): string | undefined {
  const existing = forward.length === 1 ? forward[0] : undefined;
  return existing !== undefined && reverse.length === 1 && existing.id === reverse[0]?.id
    ? existing.id
    : undefined;
}
function beforeEffect(selected: Input, state: State): LinkFailure | undefined {
  const forward = matchingIssueEdges(state.inward, state.outward.issue, selected.type, "outward");
  const reverse = matchingIssueEdges(state.outward, state.inward.issue, selected.type, "inward");
  if (selected.linkId !== undefined)
    return forward.some((item) => item.id === selected.linkId) &&
      reverse.some((item) => item.id === selected.linkId)
      ? undefined
      : linkConflict(
          "Both complete native issue relations must contain the exact reviewed link before deletion.",
        );
  if (forward.length === 0 && reverse.length === 0) return undefined;
  const existing = existingLinkId(forward, reverse);
  if (existing !== undefined)
    return linkUnchanged(
      "This exact relation already exists on both issues. No duplicate was created.",
      { ...receiptFor(selected, state), linkId: existing },
    );
  return linkConflict(
    "The relation is duplicated or the two complete issue link lists disagree. Review the native relations before creating another link.",
  );
}
async function templateAdmission(
  request: JiraMutationRequest,
  selected: Input,
  state: State,
  source: JiraIssueTemplateSource | undefined,
): Promise<LinkObservation<true>> {
  for (const [current, other, direction] of [
    [state.inward, state.outward, "outward"],
    [state.outward, state.inward, "inward"],
  ] as const) {
    const retained = current.edges.filter((edge) => edge.id !== selected.linkId);
    const planned =
      selected.linkId === undefined
        ? [
            ...edgeFields(retained),
            {
              type: { ...selected.type },
              [`${direction}Issue`]: { id: other.issue.id, key: other.issue.key },
            },
          ]
        : edgeFields(retained);
    const gate = await gateJiraMutationByTemplates({
      request,
      source,
      operation: "edit",
      metadata: [],
      target: { issueKey: current.issue.id },
      validated: { fields: { issuelinks: planned }, update: {} },
      plannedIssueLinks: planned,
    });
    if (!gate.ok) return gate;
  }
  return { ok: true, value: true };
}
function sameParents(left: State, right: State): boolean {
  return (
    sameLinkParent(left.inward.issue, right.inward.issue) &&
    sameLinkParent(left.outward.issue, right.outward.issue)
  );
}
function sameState(left: State, right: State): boolean {
  return (
    sameParents(left, right) &&
    sameIssueEdges(left.inward.edges, right.inward.edges) &&
    sameIssueEdges(left.outward.edges, right.outward.edges)
  );
}
function remainingMatches(before: State, after: State, linkId: string, deleting: boolean): boolean {
  return (["inward", "outward"] as const).every((side) => {
    const prior = deleting
      ? before[side].edges.filter((edge) => edge.id !== linkId)
      : before[side].edges;
    const current = deleting
      ? after[side].edges
      : after[side].edges.filter((edge) => edge.id !== linkId);
    return sameIssueEdges(prior, current);
  });
}
function confirmDeletedLink(
  prior: State,
  current: State,
  linkId: string,
  receipt: JiraLinkMutationReceipt,
): JiraLinkMutationAttempt {
  return remainingMatches(prior, current, linkId, true)
    ? { ok: true, receipt }
    : linkConflict(
        "The complete same-parent relations did not confirm removal of only the reviewed link. Do not replay.",
        receipt,
      );
}
function createdLinkId(selected: Input, prior: State, current: State): string | undefined {
  const matches = matchingIssueEdges(
    current.inward,
    current.outward.issue,
    selected.type,
    "outward",
  ).filter((edge) => !prior.inward.edges.some((old) => old.id === edge.id));
  return matches.length === 1 ? matches[0]?.id : undefined;
}
async function confirmCreatedLink(
  request: JiraMutationRequest,
  selected: Input,
  prior: State,
  current: State,
  linkId: string,
  receipt: JiraLinkMutationReceipt,
): Promise<JiraLinkMutationAttempt> {
  const reverse = matchingIssueEdges(
    current.outward,
    current.inward.issue,
    selected.type,
    "inward",
  );
  if (
    reverse.length !== 1 ||
    reverse[0]?.id !== linkId ||
    !remainingMatches(prior, current, linkId, false)
  )
    return linkConflict(
      "The new link ID is known, but both complete issue relations did not confirm the exact change. Do not replay.",
      receipt,
    );
  const detail = await confirmIssueLinkIdentity(
    request,
    linkId,
    selected.type,
    current.inward.issue,
    current.outward.issue,
  );
  return detail.ok ? { ok: true, receipt } : { ...detail, receipt };
}
async function confirm(
  request: JiraMutationRequest,
  selected: Input,
  prior: State,
  receipt: JiraLinkMutationReceipt,
): Promise<JiraLinkMutationAttempt> {
  let known = receipt;
  try {
    const current = await inspect(request, {
      ...selected,
      inward: prior.inward.issue.id,
      outward: prior.outward.issue.id,
    });
    if (!current.ok) return { ...current, receipt: known };
    if (!sameParents(prior, current.value)) return { ...LINK_MALFORMED, receipt: known };
    if (selected.linkId !== undefined)
      return confirmDeletedLink(prior, current.value, selected.linkId, known);
    const linkId = createdLinkId(selected, prior, current.value);
    if (linkId === undefined)
      return linkConflict(
        "The acknowledged creation has no unique new native relation in the complete issue list. Do not replay.",
        known,
      );
    known = { ...known, linkId };
    // Keep detail failures inside this ACK boundary with the newly observed native ID.
    return await confirmCreatedLink(request, selected, prior, current.value, linkId, known);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, known);
  }
}
export function isJiraIssueLinkMutation(name: string): name is Operation {
  return name === "jira.create-issue-link" || name === "jira.delete-issue-link";
}
async function admitIssueLink(
  request: JiraMutationRequest,
  selected: Input,
  templates: JiraIssueTemplateSource | undefined,
): Promise<LinkObservation<State>> {
  const prior = await inspect(request, selected, true);
  if (!prior.ok) return prior;
  const refusal = beforeEffect(selected, prior.value);
  if (refusal !== undefined) return refusal;
  if (selected.linkId !== undefined) {
    const detail = await confirmIssueLinkIdentity(
      request,
      selected.linkId,
      selected.type,
      prior.value.inward.issue,
      prior.value.outward.issue,
    );
    if (!detail.ok) return detail;
  }
  const gate = await templateAdmission(request, selected, prior.value, templates);
  if (!gate.ok) return gate;
  const rechecked = await inspect(
    request,
    {
      ...selected,
      inward: prior.value.inward.issue.id,
      outward: prior.value.outward.issue.id,
    },
    true,
  );
  if (!rechecked.ok) return rechecked;
  if (!sameState(prior.value, rechecked.value))
    return linkConflict(
      "The actor, issues or complete relation snapshot changed during admission. Nothing was written.",
    );
  return prior;
}
function dispatchIssueLink(
  request: JiraMutationRequest,
  selected: Input,
  state: State,
): ReturnType<JiraMutationRequest> {
  return selected.linkId === undefined
    ? request(
        "issueLink",
        "POST",
        {
          type: { id: selected.type.id },
          inwardIssue: { id: state.inward.issue.id },
          outwardIssue: { id: state.outward.issue.id },
        },
        "none",
      )
    : request(`issueLink/${selected.linkId}`, "DELETE", undefined, "none");
}
/** One relation effect, with the same saved-template gate as ordinary issue edits. */
export async function executeJiraIssueLinkMutation(
  operation: Operation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<JiraLinkMutationAttempt> {
  return runLinkMutation(
    {
      selected: input(operation, args),
      invalid: invalidMessage(operation, args),
      admit: (selected) => admitIssueLink(request, selected, templates),
      receiptFor,
      dispatch: (selected, state) => dispatchIssueLink(request, selected, state),
      settle: (selected, state, receipt) => confirm(request, selected, state, receipt),
    },
    check,
  );
}
