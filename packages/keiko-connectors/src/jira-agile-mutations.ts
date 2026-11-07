import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  agileDateRange,
  parseAgileMutation,
  type AgileMutationInput,
} from "./jira-agile-inputs.js";
import {
  agileBoardConfiguration,
  agileEpic,
  agileId,
  agileSprint,
} from "./jira-agile-projection.js";
import { jiraAgileRequests, type JiraAgileRequests } from "./jira-agile-request.js";
import type {
  JiraIssueTemplateSource,
  JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
import { gateJiraAgileIssueChange } from "./jira-agile-templates.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import {
  AGILE_MALFORMED,
  confirmAgileEntity,
  readAgileEntity,
  agileEntityReceipt,
  type AgileProjection,
  type AgileFailure,
} from "./jira-agile-confirmation.js";
import { mutateAgileMembership } from "./jira-agile-membership.js";

async function create(
  request: JiraMutationRequest,
  input: AgileMutationInput,
): Promise<JiraMutationAttempt> {
  const board = input.operation === "jira.board-create";
  const root = board ? "board" : "sprint";
  const response = await request(root, "POST", input.body);
  if (!response.ok) return dispatchFailure(response);
  const id = agileId(response.body?.id);
  if (response.status !== 201 || id === undefined) return AGILE_MALFORMED;
  const receipt: JiraMutationReceipt = board ? { boardId: id } : { sprintId: id };
  return confirmAgileEntity(
    request,
    `${root}/${id}${board ? "/configuration" : ""}`,
    board ? agileBoardConfiguration : agileSprint,
    id,
    { ...input.body, ...(board ? {} : { state: "future" }) },
    receipt,
  );
}
function canStartSprint(current: CatalogJsonObject, start: unknown, end: unknown): boolean {
  return current.state === "future" && typeof start === "string" && typeof end === "string";
}
function sprintTransition(
  body: CatalogJsonObject,
  current: CatalogJsonObject,
): AgileFailure | undefined {
  if (current.state === "closed") return { ok: false, reason: "invalid-transition" };
  const start = body.startDate ?? current.startDate;
  const end = body.endDate ?? current.endDate;
  if (!agileDateRange(start, end)) return { ok: false, reason: "field-validation" };
  if (body.state === undefined) return undefined;
  if (body.state === "active")
    return canStartSprint(current, start, end)
      ? undefined
      : { ok: false, reason: "invalid-transition" };
  if (body.state === "closed" && current.state === "active") return undefined;
  return { ok: false, reason: "invalid-transition" };
}
interface UpdateSelection {
  readonly path: string;
  readonly project: AgileProjection;
  readonly id: string;
  readonly receipt: JiraMutationReceipt;
}
function updateAdmission(
  requests: JiraAgileRequests,
  input: AgileMutationInput,
  source: JiraIssueTemplateSource | undefined,
  item: CatalogJsonObject,
): Promise<JiraTemplateGateResult> {
  return input.operation === "jira.sprint-update"
    ? Promise.resolve(sprintTransition(input.body, item) ?? { ok: true })
    : gateJiraAgileIssueChange(requests, source, input, item);
}
async function sendUpdate(
  request: JiraMutationRequest,
  input: AgileMutationInput,
  selected: UpdateSelection,
): Promise<JiraMutationAttempt> {
  const response = await request(selected.path, "POST", input.body);
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || agileId(response.body?.id) !== selected.id)
    return { ...AGILE_MALFORMED, receipt: selected.receipt };
  if (input.target === undefined) return { ...AGILE_MALFORMED, receipt: selected.receipt };
  return confirmAgileEntity(
    request,
    selected.path,
    selected.project,
    input.target,
    input.body,
    selected.receipt,
  );
}
async function update(
  requests: JiraAgileRequests,
  input: AgileMutationInput,
  source: JiraIssueTemplateSource | undefined,
  checkOnly: boolean,
): Promise<JiraMutationAttempt> {
  const request = requests.agile;
  if (input.target === undefined) return AGILE_MALFORMED;
  const sprint = input.operation === "jira.sprint-update";
  const path = `${sprint ? "sprint" : "epic"}/${encodeURIComponent(input.target)}`;
  const project = sprint ? agileSprint : agileEpic;
  const current = await readAgileEntity(request, path, project, input.target);
  if (!current.ok) return current;
  const admission = await updateAdmission(requests, input, source, current.item);
  if (!admission.ok) return admission;
  if (checkOnly) return { ok: true, receipt: {} };
  const receipt = agileEntityReceipt(current.item, sprint);
  return receipt === undefined
    ? AGILE_MALFORMED
    : sendUpdate(request, input, { path, project, id: current.item.id, receipt });
}
/** Existing governed dispatch owns admission/journaling; this adapter supplies fixed native effects. */
export async function executeJiraAgileMutation(
  operation: string,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraMutationAttempt> {
  return dispatchAgileMutation(operation, args, context, connection, false);
}
/** The existing pre-approval lane uses precisely the same admission, with every effect disabled. */
export async function checkJiraAgileMutationTemplates(
  operation: string,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraTemplateGateResult> {
  const attempt = await checkJiraAgileMutation(operation, args, context, connection);
  return attempt.ok
    ? { ok: true }
    : {
        ok: false,
        reason: attempt.reason,
        ...(attempt.violations === undefined ? {} : { violations: attempt.violations }),
      };
}
/** Full read-only admission result for the existing field/template preflight owner. */
export function checkJiraAgileMutation(
  operation: string,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraMutationAttempt> {
  return dispatchAgileMutation(operation, args, context, connection, true);
}
async function dispatchAgileMutation(
  operation: string,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  checkOnly: boolean,
): Promise<JiraMutationAttempt> {
  const input = parseAgileMutation(operation, args);
  if (input === undefined)
    return {
      ok: false,
      reason: "field-validation",
      detail: {
        validation: "invalid-field",
        messages: [
          "Use only this operation's typed arguments. IDs must be canonical decimal strings; membership requires 1 to 50 unique issue keys. Nothing was changed.",
        ],
      },
    };
  if (connection.deployment !== "data-center") return { ok: false, reason: "unavailable" };
  const requests = jiraAgileRequests(connection, context);
  if (input.issues !== undefined)
    return mutateAgileMembership(requests, input, connection.issueTemplates, checkOnly);
  return input.operation === "jira.board-create" || input.operation === "jira.sprint-create"
    ? checkOnly
      ? { ok: true, receipt: {} }
      : create(requests.agile, input)
    : update(requests, input, connection.issueTemplates, checkOnly);
}
