import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { sameWorkflowScheme } from "./jira-workflow-scheme-values.js";
import {
  admitWorkflowSchemeMutation,
  readReviewedScheme,
  readSchemeDraftSelection,
  readWorkflowSchemeSnapshot,
} from "./jira-workflow-scheme-mutation-observations.js";
import {
  desiredWorkflowScheme,
  workflowSchemeCanConfirm,
  workflowSchemeEffect,
  workflowSchemeReceipt,
} from "./jira-workflow-scheme-mutation-plan.js";
import {
  parseWorkflowSchemeInput,
  workflowSchemeRefusal,
  WORKFLOW_SCHEME_MALFORMED,
  type JiraWorkflowSchemeMutation,
  type WorkflowSchemeAttempt,
  type WorkflowSchemeFailure,
  type WorkflowSchemeInput,
  type WorkflowSchemeMutationReceipt,
} from "./jira-workflow-scheme-mutation-input.js";
export {
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  isJiraWorkflowSchemeMutation,
  type JiraWorkflowSchemeMutation,
} from "./jira-workflow-scheme-mutation-input.js";

function unconfirmed(receipt: WorkflowSchemeMutationReceipt): WorkflowSchemeFailure {
  return workflowSchemeRefusal(
    "Jira acknowledged the configuration request. The bounded native observations do not prove all project/deployment consequences or exact desired configuration. Keep the known identities and do not replay; a draft is not a deployed workflow.",
    "unavailable",
    receipt,
  );
}
async function confirmDraft(
  request: JiraMutationRequest,
  input: WorkflowSchemeInput,
  receipt: WorkflowSchemeMutationReceipt,
): Promise<WorkflowSchemeAttempt> {
  const parent = input.expectedScheme;
  if (parent === undefined) return { ...WORKFLOW_SCHEME_MALFORMED, receipt };
  const unchangedParent = await readReviewedScheme(request, parent, `workflowscheme/${parent.id}`);
  if (unchangedParent !== undefined) return { ...unchangedParent, receipt };
  const selected = await readSchemeDraftSelection(request, parent);
  if (!selected.ok) return { ...selected, receipt };
  if (input.kind === "delete")
    return !selected.value.draft && sameWorkflowScheme(selected.value, parent)
      ? { ok: true, receipt }
      : unconfirmed(receipt);
  const desired = desiredWorkflowScheme(input, receipt.draftSchemeId);
  if (
    desired === undefined ||
    !selected.value.draft ||
    !sameWorkflowScheme(selected.value, desired)
  )
    return unconfirmed(receipt);
  const direct = await readReviewedScheme(request, desired, `workflowscheme/${parent.id}/draft`);
  return direct === undefined ? { ok: true, receipt } : { ...direct, receipt };
}
async function confirmScheme(
  request: JiraMutationRequest,
  input: WorkflowSchemeInput,
  receipt: WorkflowSchemeMutationReceipt,
): Promise<WorkflowSchemeAttempt> {
  if (receipt.schemeId === undefined) return unconfirmed(receipt);
  const actual = await readWorkflowSchemeSnapshot(request, `workflowscheme/${receipt.schemeId}`);
  if (!actual.ok) return { ...actual, receipt };
  if (input.kind === "delete") return unconfirmed(receipt);
  const desired = desiredWorkflowScheme(input, receipt.schemeId);
  if (desired === undefined || !sameWorkflowScheme(actual.value, desired))
    return unconfirmed(receipt);
  // The same exact configured parent must remain the native fallback, not an implicit draft.
  const selected = await readSchemeDraftSelection(request, actual.value);
  if (!selected.ok) return { ...selected, receipt };
  if (selected.value.draft || !sameWorkflowScheme(selected.value, actual.value))
    return unconfirmed(receipt);
  return workflowSchemeCanConfirm(input) ? { ok: true, receipt } : unconfirmed(receipt);
}
async function confirm(
  request: JiraMutationRequest,
  input: WorkflowSchemeInput,
  receipt: WorkflowSchemeMutationReceipt,
): Promise<WorkflowSchemeAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ...actor, receipt };
  return input.draft
    ? confirmDraft(request, input, receipt)
    : confirmScheme(request, input, receipt);
}
function acknowledgementReceipt(
  input: WorkflowSchemeInput,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
): WorkflowSchemeMutationReceipt | undefined {
  if (input.kind !== "create" && input.kind !== "create-draft") return workflowSchemeReceipt(input);
  const id = jiraNativeNumericId(response.body?.id);
  if (id === undefined) return undefined;
  return input.kind === "create"
    ? workflowSchemeReceipt(input, id)
    : workflowSchemeReceipt(input, input.expectedScheme?.id, id);
}
async function dispatch(
  request: JiraMutationRequest,
  input: WorkflowSchemeInput,
): Promise<WorkflowSchemeAttempt> {
  const effect = workflowSchemeEffect(input);
  if (effect === undefined) return WORKFLOW_SCHEME_MALFORMED;
  const known = workflowSchemeReceipt(input);
  const response = await request(effect.path, effect.method, effect.body, effect.expect);
  if (!response.ok) return { ...dispatchFailure(response), receipt: known };
  if (response.status < 200 || response.status >= 300)
    return { ...WORKFLOW_SCHEME_MALFORMED, receipt: known };
  const receipt = acknowledgementReceipt(input, response);
  if (receipt === undefined)
    return workflowSchemeRefusal(
      "Jira acknowledged creation without a usable exact new identity. Keep the known actor/parent; do not infer an ID from a name, URI or a later list and do not repeat the POST.",
      "unavailable",
      known,
    );
  try {
    return await confirm(request, input, receipt);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** WorkflowSchemeResource only. No publishing, workflow definition editing or status migration.
 * Base writes fix updateDraftIfNeeded:false; existing drafts require explicit reviewed snapshots.
 * Native Jira decides whether the base is active/editable; draft:false is not activity evidence.
 */
export async function executeJiraWorkflowSchemeMutation(
  operation: JiraWorkflowSchemeMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<WorkflowSchemeAttempt> {
  const input = parseWorkflowSchemeInput(operation, args);
  if (input === undefined)
    return workflowSchemeRefusal(
      "Use the exact connected actor key and complete current parent/draft review snapshots. Configured default and description must be explicitly observed, including null. Supply only fixed mapping selectors; draft creation is separate, and no publish or migration input is accepted.",
    );
  const reserved = workflowSchemeReceipt(
    input,
    input.expectedScheme?.id ?? "9223372036854775807",
    input.draft ? (input.expectedDraft?.id ?? "9223372036854775807") : undefined,
  );
  if (new TextEncoder().encode(JSON.stringify(reserved)).byteLength > 16384)
    return workflowSchemeRefusal(
      "The known configuration receipt exceeds the existing 16 KiB bound. Reduce selected metadata before any request.",
    );
  const refused = await admitWorkflowSchemeMutation(request, input);
  if (refused !== undefined) return refused;
  return check ? { ok: true, receipt: {} } : dispatch(request, input);
}
