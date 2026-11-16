import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraSubtaskMembership } from "./jira-issue-context-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { jiraNativeId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  ISSUE_LIFECYCLE_MALFORMED,
  issueLifecycleFailure,
  issueLifecycleRefusal,
  type IssueLifecycleFailure,
  type IssueLifecycleInput,
  type IssueLifecycleObservation,
  type IssueLifecycleReview,
  type IssueLifecycleSubtask,
} from "./jira-issue-lifecycle-values.js";

type ObservedIssue = Extract<
  Awaited<ReturnType<typeof readJiraMutationIssue>>,
  { readonly ok: true }
>;
function observedIdentity(
  issue: ObservedIssue,
): Pick<IssueLifecycleReview, "id" | "key" | "summary" | "projectId" | "issueTypeId"> | undefined {
  const project = asRecord(issue.fields.project);
  const type = asRecord(issue.fields.issuetype);
  if (
    !jiraNativeId(issue.id) ||
    !isSafeAtlassianIdentifier(issue.key) ||
    !jiraNativeId(project?.id) ||
    !jiraNativeId(type?.id) ||
    typeof issue.fields.summary !== "string"
  )
    return undefined;
  return {
    id: issue.id,
    key: issue.key,
    summary: issue.fields.summary,
    projectId: project.id,
    issueTypeId: type.id,
  };
}
/** Whether a fresh read of the issue answers 404, however the transport delivers that status. */
export async function issueIsGone(
  request: JiraMutationRequest,
  issue: IssueLifecycleReview,
): Promise<boolean> {
  // The same read the identity check makes, so the transport and the fixtures see one request shape.
  const response = await request(
    `issue/${encodeURIComponent(issue.id)}?fields=issuetype%2Cproject%2Csummary`,
  );
  return response.ok ? response.status === 404 : response.reason === "not-found";
}
export async function bindIssueLifecycleIssue(
  request: JiraMutationRequest,
  expected: IssueLifecycleReview,
): Promise<IssueLifecycleFailure | undefined> {
  const issue = await readJiraMutationIssue(request, expected.id, [
    "summary",
    "project",
    "issuetype",
  ]);
  if (!issue.ok) return issueLifecycleFailure(issue);
  const observed = observedIdentity(issue);
  if (observed === undefined) return ISSUE_LIFECYCLE_MALFORMED;
  return observed.id === expected.id &&
    observed.key === expected.key &&
    observed.summary === expected.summary &&
    observed.projectId === expected.projectId &&
    observed.issueTypeId === expected.issueTypeId
    ? undefined
    : issueLifecycleRefusal(
        "The exact issue identity, project, type or reviewed summary changed. Review the current issue before sending a new request.",
        "conflict",
      );
}
function subtask(value: unknown, parent: IssueLifecycleReview): IssueLifecycleSubtask | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeId(raw.id) || !isSafeAtlassianIdentifier(raw.key))
    return undefined;
  if (
    raw.self !== undefined &&
    raw.self !== null &&
    !jiraResourceSelfMatches(raw.self, `issue/${raw.id}`) &&
    !jiraResourceSelfMatches(raw.self, `issue/${raw.key}`)
  )
    return undefined;
  return jiraSubtaskMembership(value, { issueId: parent.id, issueKey: parent.key })
    ? { id: raw.id, key: raw.key }
    : undefined;
}
export async function readIssueLifecycleSubtasks(
  request: JiraMutationRequest,
  parent: IssueLifecycleReview,
): Promise<IssueLifecycleObservation<readonly IssueLifecycleSubtask[]>> {
  const response = await request(`issue/${parent.id}/subtask`, "GET", undefined, "json-array");
  if (!response.ok) return issueLifecycleFailure(dispatchFailure(response));
  if (response.status !== 200 || response.items === undefined) return ISSUE_LIFECYCLE_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const values: IssueLifecycleSubtask[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const raw of response.items) {
    const item = subtask(raw, parent);
    if (item === undefined || ids.has(item.id) || keys.has(item.key.toUpperCase()))
      return ISSUE_LIFECYCLE_MALFORMED;
    ids.add(item.id);
    keys.add(item.key.toUpperCase());
    values.push(item);
  }
  return { ok: true, value: values };
}
function sameSubtasks(
  left: readonly IssueLifecycleSubtask[],
  right: readonly IssueLifecycleSubtask[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) => item.id === right.at(index)?.id && item.key === right.at(index)?.key,
    )
  );
}
async function reorderAvailability(
  request: JiraMutationRequest,
  issue: IssueLifecycleReview,
): Promise<IssueLifecycleFailure | undefined> {
  const available = await request(
    `issue/${issue.id}/subtask/move`,
    "GET",
    undefined,
    "json-scalar",
  );
  if (!available.ok) return issueLifecycleFailure(dispatchFailure(available));
  if (available.status !== 200 || typeof available.scalar !== "boolean")
    return ISSUE_LIFECYCLE_MALFORMED;
  return available.scalar
    ? undefined
    : issueLifecycleRefusal(
        "Jira reports that this parent cannot currently reorder subtasks. Nothing was sent.",
        "unavailable",
      );
}
async function admitSubtasks(
  request: JiraMutationRequest,
  input:
    | Extract<IssueLifecycleInput, { kind: "reorder" }>
    | Extract<IssueLifecycleInput, { kind: "archive" | "restore" | "delete" }>,
): Promise<IssueLifecycleFailure | undefined> {
  if (input.kind !== "delete" && input.kind !== "reorder") return undefined;
  const subtasks = await readIssueLifecycleSubtasks(request, input.issue);
  if (!subtasks.ok) return subtasks;
  const expected = input.kind === "delete" ? [] : input.subtasks;
  if (!sameSubtasks(subtasks.value, expected))
    return issueLifecycleRefusal(
      "The complete returned native subtask sequence differs from the review. A visible list is not a global population proof; deletion additionally keeps native deleteSubtasks=false.",
      "conflict",
    );
  if (input.kind === "delete") return undefined;
  return reorderAvailability(request, input.issue);
}
export async function admitIssueLifecycle(
  request: JiraMutationRequest,
  input: IssueLifecycleInput,
): Promise<IssueLifecycleFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return issueLifecycleFailure(actor);
  const issues = input.kind === "archive-many" ? input.issues : [input.issue];
  for (const issue of issues) {
    const refused = await bindIssueLifecycleIssue(request, issue);
    if (refused !== undefined) return refused;
  }
  return input.kind === "archive-many" ? undefined : admitSubtasks(request, input);
}
