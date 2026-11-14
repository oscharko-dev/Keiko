import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { JiraPrepareCreate, PreparedJiraCreate } from "./jira-create-preparation.js";
import {
  bulkCreateReceipt,
  bulkCreateReceiptFits,
  bulkCreateRefusal,
  jiraBulkCreateAcknowledgement,
  parseJiraBulkCreateInput,
  type JiraBulkCreateAcknowledgement,
  type JiraBulkCreateAttempt,
  type JiraBulkCreateFailure,
  type JiraBulkCreateInput,
  type JiraBulkCreateReceipt,
} from "./jira-bulk-create-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import type { JiraTraceRequest } from "./jira-requirement-trace.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";

export interface JiraBulkCreatePorts {
  readonly prepare: JiraPrepareCreate;
  /** Existing server-owned validated trace for the explicit common requirementIds, never model text. */
  readonly trace?: JiraTraceRequest;
}
export function isJiraBulkCreate(name: string): name is "jira.create-issues" {
  return name === "jira.create-issues";
}
function preparationFailure(
  failure: Extract<JiraMutationAttempt, { ok: false }>,
): JiraBulkCreateFailure {
  return {
    ok: false,
    reason: failure.reason,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(failure.violations === undefined ? {} : { violations: failure.violations }),
  };
}
type PreparedBatch =
  JiraBulkCreateFailure | { readonly ok: true; readonly items: readonly PreparedJiraCreate[] };
async function prepareBatch(
  input: JiraBulkCreateInput,
  ports: JiraBulkCreatePorts,
): Promise<PreparedBatch> {
  const items: PreparedJiraCreate[] = [];
  const identities = new Set<string>();
  const payloads = new Set<string>();
  for (const issue of input.issues) {
    const args =
      input.requirementIds === undefined
        ? issue
        : { ...issue, requirementIds: input.requirementIds };
    const prepared = await ports.prepare(args, ports.trace);
    if (!prepared.ok) return preparationFailure(prepared);
    if (prepared.plan.further.length > 0)
      return bulkCreateRefusal(
        "This item requires separate follow-up link writes. The native bulk path supports only fully inline effects; use the existing governed individual create path instead. No bulk request was sent.",
      );
    const payload = canonicalise(prepared.body);
    if (
      payloads.has(payload) ||
      (prepared.draftIdentity !== undefined && identities.has(prepared.draftIdentity))
    )
      return bulkCreateRefusal(
        "Two reviewed items resolve to the same create payload or existing draft identity. Resolve the duplicate before any bulk request.",
        "conflict",
      );
    payloads.add(payload);
    if (prepared.draftIdentity !== undefined) identities.add(prepared.draftIdentity);
    items.push(prepared);
  }
  return { ok: true, items };
}
function withReceipt(
  failure: Extract<JiraMutationAttempt, { ok: false }>,
  receipt: JiraBulkCreateReceipt,
): JiraBulkCreateFailure {
  return { ...preparationFailure(failure), receipt };
}
async function observeCreated(
  request: JiraMutationRequest,
  ack: JiraBulkCreateAcknowledgement,
): Promise<JiraBulkCreateFailure | undefined> {
  for (const selected of ack.identities) {
    const issue = await readJiraMutationIssue(request, selected.id, [
      "summary",
      "project",
      "issuetype",
    ]);
    if (!issue.ok) return withReceipt(issue, ack.receipt);
    if (issue.id !== selected.id || issue.key !== selected.key)
      return bulkCreateRefusal(
        "A fresh issue identity differs from its native bulk acknowledgement. Keep the observed ACK IDs and do not replay the batch.",
        "conflict",
        ack.receipt,
      );
  }
  return undefined;
}
async function afterAcknowledgement(
  request: JiraMutationRequest,
  input: JiraBulkCreateInput,
  ack: JiraBulkCreateAcknowledgement,
  status: number,
): Promise<JiraBulkCreateFailure> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return withReceipt(actor, ack.receipt);
  const refused = await observeCreated(request, ack);
  if (refused !== undefined) return refused;
  if (!ack.valid || status !== 201)
    return {
      ok: false,
      reason: "malformed-payload",
      receipt: ack.receipt,
      ...(ack.detail === undefined ? {} : { detail: ack.detail }),
    };
  return {
    ...bulkCreateRefusal(
      "Jira acknowledged one native bulk request. The known IDs are only observed ACK identities, not an index-based mapping to requested items or proof of complete field/link effects. Native failedElementNumber values keep their original meaning. Review known issues and failures individually; never replay the batch.",
      "unavailable",
      ack.receipt,
    ),
    ...(ack.detail === undefined ? {} : { detail: ack.detail }),
  };
}
async function dispatch(
  request: JiraMutationRequest,
  input: JiraBulkCreateInput,
  prepared: readonly PreparedJiraCreate[],
  receipt: JiraBulkCreateReceipt,
): Promise<JiraBulkCreateFailure> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return preparationFailure(actor);
  const response = await request(
    "issue/bulk",
    "POST",
    { issueUpdates: prepared.map((item) => item.body) },
    "json",
  );
  if (!response.ok) return withReceipt(dispatchFailure(response), receipt);
  let known = receipt;
  try {
    const ack = jiraBulkCreateAcknowledgement(response.body, receipt);
    known = ack.receipt;
    return await afterAcknowledgement(request, input, ack, response.status);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, known);
  }
}
/** One bulk effect after every item has passed the existing single-create preparation owner.
 * This never loops individual POSTs, follows up links, reconciles by name, or replays a subset. */
export async function executeJiraBulkCreate(
  _operation: "jira.create-issues",
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraBulkCreatePorts | undefined,
  check = false,
): Promise<JiraBulkCreateAttempt> {
  const input = parseJiraBulkCreateInput(args);
  if (input === undefined)
    return bulkCreateRefusal(
      "Supply expectedActorKey,1..50 distinct issues with existing create projectId/issueTypeId/fields/links inputs, and confirmUnverifiedEffect:true. Optional top-level requirementIds apply to every issue; per-item references and temporary draft targets are not accepted.",
    );
  if (ports === undefined)
    return bulkCreateRefusal(
      "The existing governed create-preparation owner is unavailable. No native request was sent.",
      "unavailable",
    );
  if (input.requirementIds !== undefined && ports.trace === undefined)
    return bulkCreateRefusal(
      "Requirement references cannot be traced in this session; no issue was changed. Use the existing traced create path or remove the explicit references.",
    );
  if (!bulkCreateReceiptFits(input)) return { ok: false, reason: "bounds-exceeded" };
  const receipt = bulkCreateReceipt(input);
  const actor = await readSavedActor(request, input.actor, { beforeEffect: true });
  if (!actor.ok) return preparationFailure(actor);
  const prepared = await prepareBatch(input, ports);
  if (!prepared.ok) return prepared;
  return check ? { ok: true, receipt: {} } : dispatch(request, input, prepared.items, receipt);
}
