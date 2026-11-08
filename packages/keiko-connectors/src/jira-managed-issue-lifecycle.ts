import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationBody, JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraSchemaRuleImpact,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  admitIssueLifecycle,
  bindIssueLifecycleIssue,
  readIssueLifecycleSubtasks,
} from "./jira-issue-lifecycle-observations.js";
import {
  ISSUE_LIFECYCLE_MALFORMED,
  issueLifecycleFailure,
  issueLifecycleReceipt,
  issueLifecycleRefusal,
  parseIssueLifecycleInput,
  type IssueLifecycleAttempt,
  type IssueLifecycleFailure,
  type IssueLifecycleInput,
  type IssueLifecycleReceipt,
  type JiraIssueLifecycleMutation,
} from "./jira-issue-lifecycle-values.js";
export {
  JIRA_ISSUE_LIFECYCLE_MUTATIONS,
  isJiraIssueLifecycleMutation,
  type JiraIssueLifecycleMutation,
} from "./jira-issue-lifecycle-values.js";

/** Internal composition of the existing saved-rule impact owner, never a model input.
 * The callback must evaluate the current complete source, not a cached approval verdict. */
export interface JiraIssueLifecyclePorts {
  readonly deletionAdmission?: () => Promise<
    Extract<JiraMutationAttempt, { ok: false }> | undefined
  >;
}
/** Composition only; the existing formal owner decides which surviving references are affected. */
export function jiraIssueDeletionAdmission(
  request: JiraMutationRequest,
  source: JiraIssueTemplateSource | undefined,
): JiraIssueLifecyclePorts {
  return {
    deletionAdmission: async (): ReturnType<
      NonNullable<JiraIssueLifecyclePorts["deletionAdmission"]>
    > => {
      const gate = await gateJiraSchemaRuleImpact({
        request,
        source,
        impact: { kind: "issue-deletion" },
      });
      return gate.ok ? undefined : gate;
    },
  };
}
interface Effect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: JiraMutationBody;
}
function effect(input: IssueLifecycleInput): Effect {
  if (input.kind === "archive-many")
    return {
      path: "issue/archive?notifyUsers=true",
      method: "POST",
      body: input.issues.map((issue) => issue.key),
    };
  if (input.kind === "delete")
    return { path: `issue/${input.issue.id}?deleteSubtasks=false`, method: "DELETE" };
  if (input.kind === "reorder")
    return {
      path: `issue/${input.issue.id}/subtask/move`,
      method: "POST",
      body: { original: input.original, current: input.current },
    };
  return { path: `issue/${input.issue.id}/${input.kind}?notifyUsers=true`, method: "PUT" };
}
async function readback(
  request: JiraMutationRequest,
  input: IssueLifecycleInput,
  receipt: IssueLifecycleReceipt,
): Promise<IssueLifecycleAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ...actor, receipt };
  const issues = input.kind === "archive-many" ? input.issues : [input.issue];
  for (const issue of issues) {
    const refused = await bindIssueLifecycleIssue(request, issue);
    if (refused !== undefined) return { ...refused, receipt };
  }
  if (input.kind === "reorder") {
    const current = await readIssueLifecycleSubtasks(request, input.issue);
    if (!current.ok) return { ...current, receipt };
  }
  return issueLifecycleRefusal(
    "Jira acknowledged the native request. The reviewed identities and fresh direct observations do not establish every archive, deletion, notification, hidden-subtask or persisted sequence consequence. Receipt flags and positions are requested targets only. Keep the known context and do not replay.",
    "unavailable",
    receipt,
  );
}
async function admission(
  request: JiraMutationRequest,
  input: IssueLifecycleInput,
  ports: JiraIssueLifecyclePorts | undefined,
): Promise<IssueLifecycleFailure | undefined> {
  const deletionAdmission = ports?.deletionAdmission;
  if (input.kind === "delete" && deletionAdmission === undefined)
    return issueLifecycleRefusal(
      "The existing formal issue-deletion admission owner is unavailable. No native request was sent.",
      "unavailable",
    );
  const refused = await admitIssueLifecycle(request, input);
  if (refused !== undefined) return refused;
  if (input.kind !== "delete" || deletionAdmission === undefined) return undefined;
  const formal = await deletionAdmission();
  return formal === undefined ? undefined : issueLifecycleFailure(formal);
}
async function dispatch(
  request: JiraMutationRequest,
  input: IssueLifecycleInput,
  receipt: IssueLifecycleReceipt,
): Promise<IssueLifecycleAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return issueLifecycleFailure(actor);
  const target = effect(input);
  const response = await request(target.path, target.method, target.body, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300)
    return { ...ISSUE_LIFECYCLE_MALFORMED, receipt };
  try {
    return await readback(request, input, receipt);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** All admitted effects remain unconfirmed. Neither a text stream, selected404 nor a visible
 * child sequence is converted into global completion, deletion or hidden-population evidence. */
export async function executeJiraIssueLifecycleMutation(
  operation: JiraIssueLifecycleMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraIssueLifecyclePorts | undefined,
  check = false,
): Promise<IssueLifecycleAttempt> {
  const input = parseIssueLifecycleInput(operation, args);
  if (input === undefined)
    return issueLifecycleRefusal(
      "Supply the exact actor and reviewed issue identity, summary, project and type, plus confirmUnverifiedEffect:true. Bulk archive selects1..50 distinct native issues. Deletion accepts only expectedSubtasks:[] and fixes deleteSubtasks=false. Subtask moves review the complete native child sequence and explicit different original/current native positions; they never reparent an issue.",
    );
  const receipt = issueLifecycleReceipt(input);
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 16384)
    return { ok: false, reason: "bounds-exceeded" };
  const refused = await admission(request, input, ports);
  if (refused !== undefined) return refused;
  return check ? { ok: true, receipt: {} } : dispatch(request, input, receipt);
}
