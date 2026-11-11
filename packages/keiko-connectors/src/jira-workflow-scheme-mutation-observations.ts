import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraCoreMetadataProjection } from "./jira-core-metadata-values.js";
import { jiraWorkflowProjection } from "./jira-configuration-values.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  jiraWorkflowSchemeReviewSnapshot,
  sameWorkflowScheme,
  type WorkflowSchemeSnapshot,
} from "./jira-workflow-scheme-values.js";
import {
  selectedWorkflowScheme,
  desiredWorkflowScheme,
  workflowSchemeReceipt,
} from "./jira-workflow-scheme-mutation-plan.js";
import {
  workflowSchemeRefusal,
  type WorkflowSchemeFailure,
  type WorkflowSchemeInput,
  type WorkflowSchemeObservation,
} from "./jira-workflow-scheme-mutation-input.js";

export async function readWorkflowSchemeSnapshot(
  request: JiraMutationRequest,
  path: string,
): Promise<WorkflowSchemeObservation<WorkflowSchemeSnapshot>> {
  const response = await request(path, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const value =
    response.status === 200 ? jiraWorkflowSchemeReviewSnapshot(response.body) : undefined;
  return value === undefined
    ? workflowSchemeRefusal(
        "The native workflow-scheme representation does not provide complete ID, draft, name, description, configured default and mapping facts. Missing values are unavailable, not null or empty.",
        "unavailable",
      )
    : { ok: true, value };
}
export async function readReviewedScheme(
  request: JiraMutationRequest,
  expected: WorkflowSchemeSnapshot,
  path: string,
): Promise<WorkflowSchemeFailure | undefined> {
  const actual = await readWorkflowSchemeSnapshot(request, path);
  if (!actual.ok) return actual;
  return sameWorkflowScheme(actual.value, expected)
    ? undefined
    : workflowSchemeRefusal(
        "The complete reviewed workflow-scheme identity, metadata, configured default or mappings changed. Read and review the current representation before writing.",
        "conflict",
      );
}
export async function readSchemeDraftSelection(
  request: JiraMutationRequest,
  parent: WorkflowSchemeSnapshot,
): Promise<WorkflowSchemeObservation<WorkflowSchemeSnapshot>> {
  const selected = await readWorkflowSchemeSnapshot(
    request,
    `workflowscheme/${parent.id}?returnDraftIfExists=true`,
  );
  if (!selected.ok) return selected;
  if (!selected.value.draft && !sameWorkflowScheme(selected.value, parent))
    return workflowSchemeRefusal(
      "The draft-selection read returned a different base scheme. No target switch is permitted.",
      "conflict",
    );
  return selected;
}
async function admitDraft(
  request: JiraMutationRequest,
  input: WorkflowSchemeInput,
  parent: WorkflowSchemeSnapshot,
): Promise<WorkflowSchemeFailure | undefined> {
  const selected = await readSchemeDraftSelection(request, parent);
  if (!selected.ok) return selected;
  const expected = input.expectedDraft;
  if (expected === undefined)
    return selected.value.draft
      ? workflowSchemeRefusal(
          "The selected base scheme already has a draft. Review that exact draft explicitly; this operation never switches targets or replaces an unreviewed draft.",
          "conflict",
        )
      : undefined;
  if (!selected.value.draft || !sameWorkflowScheme(selected.value, expected))
    return workflowSchemeRefusal(
      "The reviewed draft no longer belongs to this readable parent or its complete configuration changed.",
      "conflict",
    );
  return readReviewedScheme(request, expected, `workflowscheme/${parent.id}/draft`);
}
async function bindWorkflow(
  request: JiraMutationRequest,
  name: string,
): Promise<WorkflowSchemeFailure | undefined> {
  const query = new URLSearchParams({ workflowName: name });
  const response = await request(`workflow?${query.toString()}`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const workflow = response.status === 200 ? jiraWorkflowProjection(response.body) : undefined;
  return workflow?.name === name
    ? undefined
    : workflowSchemeRefusal(
        "The exact selected workflow name could not be independently bound to one native workflow. No fuzzy or display-name substitution is permitted.",
        "conflict",
      );
}
async function bindIssueType(
  request: JiraMutationRequest,
  id: string,
): Promise<WorkflowSchemeFailure | undefined> {
  const response = await request(`issuetype/${id}`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const issueType =
    response.status === 200 ? jiraCoreMetadataProjection("issue-type", response.body) : undefined;
  return issueType?.id === id
    ? undefined
    : workflowSchemeRefusal(
        "The exact referenced issue-type identity could not be independently confirmed. No numeric conversion or name substitution is permitted.",
        "conflict",
      );
}
function referencedValues(input: WorkflowSchemeInput): {
  readonly workflows: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
} {
  const workflows = new Set<string>();
  const types = new Set<string>(input.issueTypeIds);
  if (input.issueTypeId !== undefined) types.add(input.issueTypeId);
  if (input.workflowName !== undefined) workflows.add(input.workflowName);
  if (typeof input.target?.defaultWorkflow === "string")
    workflows.add(input.target.defaultWorkflow);
  for (const row of input.target?.mappings ?? []) {
    workflows.add(row.workflow);
    types.add(row.issueTypeId);
  }
  return { workflows, types };
}
async function bindReferences(
  request: JiraMutationRequest,
  input: WorkflowSchemeInput,
): Promise<WorkflowSchemeFailure | undefined> {
  const selected = referencedValues(input);
  for (const name of selected.workflows) {
    const refused = await bindWorkflow(request, name);
    if (refused !== undefined) return refused;
  }
  for (const id of selected.types) {
    const refused = await bindIssueType(request, id);
    if (refused !== undefined) return refused;
  }
  return undefined;
}
function unchanged(input: WorkflowSchemeInput): WorkflowSchemeFailure | undefined {
  const before = selectedWorkflowScheme(input);
  const desired = desiredWorkflowScheme(input);
  if (before === undefined || desired === undefined || !sameWorkflowScheme(before, desired))
    return undefined;
  return {
    ...workflowSchemeRefusal(
      "The complete reviewed configuration already has the requested facts. Nothing was written; no deployment or effective workflow fallback is inferred.",
      "conflict",
      workflowSchemeReceipt(input),
    ),
    detail: {
      unchanged: true,
      messages: ["The exact reviewed configuration is unchanged. No native write was sent."],
    },
  };
}
export async function admitWorkflowSchemeMutation(
  request: JiraMutationRequest,
  input: WorkflowSchemeInput,
): Promise<WorkflowSchemeFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  const parent = input.expectedScheme;
  if (parent !== undefined) {
    const base = await readReviewedScheme(request, parent, `workflowscheme/${parent.id}`);
    if (base !== undefined) return base;
    const draft = await admitDraft(request, input, parent);
    if (draft !== undefined) return draft;
  }
  const references = await bindReferences(request, input);
  return references ?? unchanged(input);
}
