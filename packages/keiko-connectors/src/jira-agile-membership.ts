import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import type { AgileMutationInput } from "./jira-agile-inputs.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import type { JiraAgileRequests } from "./jira-agile-request.js";
import { gateJiraAgileIssueChange } from "./jira-agile-templates.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { agileEpic, agileId, agileSprint } from "./jira-agile-projection.js";
import {
  AGILE_CONFLICT,
  AGILE_MALFORMED,
  readAgileEntity,
  agileEntityReceipt,
  type AgileFailure,
} from "./jira-agile-confirmation.js";

interface Membership {
  readonly path: string;
  readonly field: "sprint" | "epic";
  readonly target: CatalogJsonObject | null;
  readonly receipt: JiraMutationReceipt;
}
type Selection = { readonly ok: true; readonly membership: Membership } | AgileFailure;
async function membershipTarget(
  request: JiraMutationRequest,
  input: AgileMutationInput,
): Promise<Selection> {
  const issueKeys = input.issues;
  if (issueKeys === undefined) return AGILE_MALFORMED;
  if (input.operation === "jira.backlog-move-issues")
    return {
      ok: true,
      membership: { path: "backlog/issue", field: "sprint", target: null, receipt: { issueKeys } },
    };
  return entityMembership(request, input, issueKeys);
}
async function entityMembership(
  request: JiraMutationRequest,
  input: AgileMutationInput,
  issueKeys: readonly string[],
): Promise<Selection> {
  if (input.target === undefined) return AGILE_MALFORMED;
  const sprint = input.operation === "jira.sprint-move-issues";
  const path = `${sprint ? "sprint" : "epic"}/${encodeURIComponent(input.target)}`;
  const current = await readAgileEntity(
    request,
    path,
    sprint ? agileSprint : agileEpic,
    input.target,
  );
  if (!current.ok) return current;
  if (sprint && current.item.state === "closed") return { ok: false, reason: "invalid-transition" };
  const entityReceipt = agileEntityReceipt(current.item, sprint);
  if (entityReceipt === undefined) return AGILE_MALFORMED;
  return {
    ok: true,
    membership: {
      path: `${path}/issue`,
      field: sprint ? "sprint" : "epic",
      target: current.item,
      receipt: { ...entityReceipt, issueKeys },
    },
  };
}
function matchesTarget(member: unknown, selection: Membership): boolean {
  if (selection.target === null) return member === null;
  const value = asRecord(member);
  if (value === undefined || agileId(value.id) !== selection.target.id) return false;
  return selection.field !== "epic" || value.key === selection.target.key;
}
async function confirmMember(
  request: JiraMutationRequest,
  key: string,
  selection: Membership,
): Promise<AgileFailure | undefined> {
  const response = await request(`issue/${encodeURIComponent(key)}?fields=${selection.field}`);
  if (!response.ok) return dispatchFailure(response);
  const body = response.body;
  const fields = asRecord(body?.fields);
  if (
    response.status !== 200 ||
    body?.key !== key ||
    agileId(body.id) === undefined ||
    fields === undefined ||
    !Object.hasOwn(fields, selection.field)
  )
    return AGILE_MALFORMED;
  return matchesTarget(fields[selection.field], selection) ? undefined : AGILE_CONFLICT;
}
/** A 204 is an acknowledgement; each selected issue must then prove its requested membership. */
export async function mutateAgileMembership(
  requests: JiraAgileRequests,
  input: AgileMutationInput,
  source: JiraIssueTemplateSource | undefined,
  checkOnly = false,
): Promise<JiraMutationAttempt> {
  const request = requests.agile;
  const selected = await membershipTarget(request, input);
  if (!selected.ok) return selected;
  const { membership } = selected;
  const admission = await gateJiraAgileIssueChange(requests, source, input, membership.target);
  if (!admission.ok) return admission;
  if (checkOnly) return { ok: true, receipt: {} };
  const response = await request(membership.path, "POST", input.body, "none");
  if (!response.ok) return dispatchFailure(response);
  const receipt = membership.receipt;
  if (response.status !== 204) return { ...AGILE_MALFORMED, receipt };
  for (const key of input.issues ?? []) {
    const failure = await confirmMember(request, key, membership);
    if (failure !== undefined) return { ...failure, receipt };
  }
  return { ok: true, receipt };
}
