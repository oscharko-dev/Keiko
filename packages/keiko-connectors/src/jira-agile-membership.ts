import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { DEFAULT_ATLASSIAN_SYNC_BOUNDS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { mapWithConcurrency } from "@oscharko-dev/keiko-contracts/runtime/bounded-concurrency";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import type { AgileMutationInput } from "./jira-agile-inputs.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import type { JiraAgileRequests } from "./jira-agile-request.js";
import { gateJiraAgileIssueChange } from "./jira-agile-templates.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
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
const SPRINT_FIELD_SCHEMA = "com.pyxis.greenhopper.jira:gh-sprint";
/** The Agile issue resource omits an empty sprint, so backlog membership is proven on the core issue
 * through the one Sprint custom field: its key must be present and name no sprint but closed ones. */
async function sprintFieldId(request: JiraMutationRequest): Promise<string | AgileFailure> {
  const response = await request("field", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return AGILE_MALFORMED;
  const ids = response.items
    .map(asRecord)
    .filter((field) => asRecord(field?.schema)?.custom === SPRINT_FIELD_SCHEMA)
    .map((field) => field?.id);
  const [id] = ids;
  return ids.length === 1 && typeof id === "string" && /^customfield_[1-9]\d*$/u.test(id)
    ? id
    : AGILE_MALFORMED;
}
function backlogFieldMissing(
  response: Extract<Awaited<ReturnType<JiraMutationRequest>>, { readonly ok: true }>,
  key: string,
  fieldId: string,
): boolean {
  const fields = asRecord(response.body?.fields);
  return (
    response.status !== 200 ||
    response.body?.key !== key ||
    agileId(response.body.id) === undefined ||
    fields === undefined ||
    !Object.hasOwn(fields, fieldId)
  );
}
/** A closed sprint stays on an issue's Sprint field as history after a backlog move. Data Center
 * renders an entry as an object or as `...Sprint@hash[id=1,rapidViewId=1,state=CLOSED,...]`; only an
 * entry that names exactly one closed state is history, and any other entry keeps the conflict. */
function closedSprintEntry(entry: unknown): boolean {
  const record = asRecord(entry);
  if (record !== undefined)
    return typeof record.state === "string" && /^closed$/iu.test(record.state);
  if (typeof entry !== "string") return false;
  const states = [...entry.matchAll(/[[,]state=([A-Za-z]+)(?=[,\]])/gu)];
  return states.length === 1 && /^closed$/iu.test(states[0]?.[1] ?? "");
}
async function confirmBacklogMember(
  request: JiraMutationRequest,
  key: string,
  fieldId: string,
): Promise<AgileFailure | undefined> {
  const response = await request(`issue/${encodeURIComponent(key)}?fields=${fieldId}`);
  if (!response.ok) return dispatchFailure(response);
  if (backlogFieldMissing(response, key, fieldId)) return AGILE_MALFORMED;
  const value = asRecord(response.body?.fields)?.[fieldId];
  const backlog = value === null || (Array.isArray(value) && value.every(closedSprintEntry));
  return backlog ? undefined : AGILE_CONFLICT;
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
  return confirmMembership(requests, input, membership);
}
async function confirmMembership(
  requests: JiraAgileRequests,
  input: AgileMutationInput,
  membership: Membership,
): Promise<JiraMutationAttempt> {
  const receipt = membership.receipt;
  const readback = requests.readback();
  try {
    const backlog = input.operation === "jira.backlog-move-issues";
    const fieldId = backlog ? await sprintFieldId(readback.issue) : undefined;
    if (typeof fieldId === "object") return { ...fieldId, receipt };
    const failures = await mapWithConcurrency(
      input.issues ?? [],
      DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxConcurrency,
      (key) =>
        fieldId === undefined
          ? confirmMember(readback.agile, key, membership)
          : confirmBacklogMember(readback.issue, key, fieldId),
      readback.signal,
    );
    const failure = failures.find((value) => value !== undefined);
    return failure === undefined ? { ok: true, receipt } : { ...failure, receipt };
  } catch (error) {
    // The acknowledged native batch cannot be replayed even when its evidence phase is cancelled.
    if (readback.signal.aborted && error === readback.signal.reason)
      return { ok: false, reason: "timeout", receipt };
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
