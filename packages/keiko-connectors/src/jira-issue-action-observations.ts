import { asRecord } from "./atlassian-sync-classify.js";
import { jiraCommentSelfMatches, normalizeJiraCommentBody } from "./jira-comment-binding.js";
import { sameJiraCommentVisibility } from "./jira-comment-visibility.js";
import { jiraIssueContextBoundsExceeded, jiraPinnedCommentProjection } from "./jira-issue-context-values.js";
import { bindLinkIssue } from "./jira-link-mutation-values.js";
import { bindJiraCommentIssue, readJiraBoundComment } from "./jira-managed-comments.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { bindRolePrincipals } from "./jira-role-mutation-observations.js";
import { ISSUE_ACTION_MALFORMED, issueActionRefusal, type IssueActionFailure, type IssueActionInput, type IssueActionObservation, type PinCommentInput } from "./jira-issue-action-values.js";

async function bindPinComment(request: JiraMutationRequest, input: PinCommentInput, baseUrl: string | undefined): Promise<IssueActionFailure | undefined> {
  const bound = await bindJiraCommentIssue(request, input, baseUrl);
  if (!bound.ok) return bound;
  if (bound.binding.issueId !== input.issueId || bound.issueKey !== input.issueKey) return issueActionRefusal("The exact reviewed issue ID/key changed. Read the current issue and comment again.", "conflict");
  const current = await readJiraBoundComment(request, input, bound.binding);
  if (!current.ok) return current;
  return normalizeJiraCommentBody(current.comment.body) === normalizeJiraCommentBody(input.expectedBody) && sameJiraCommentVisibility(current.comment.visibility, input.expectedVisibility)
    ? undefined : issueActionRefusal("The selected comment text or visibility changed after review. Review its current content before pinning it.", "conflict");
}
function pinnedParentMatches(value: unknown, binding: { readonly issueId: string; readonly baseUrl: string }): boolean {
  const raw = asRecord(asRecord(value)?.comment);
  return raw !== undefined && typeof raw.id === "string" && jiraCommentSelfMatches(raw.self, raw.id, binding);
}
export async function issueActionPinnedState(request: JiraMutationRequest, input: PinCommentInput, baseUrl: string): Promise<IssueActionObservation<boolean>> {
  const response = await request(`issue/${input.issueId}/pinned-comments`, "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return ISSUE_ACTION_MALFORMED;
  if (response.items.length > 1000 || response.items.some(jiraIssueContextBoundsExceeded)) return { ok: false, reason: "bounds-exceeded" };
  const projected = projectJiraCollection(response.items, 1000, jiraPinnedCommentProjection, "id");
  if (projected === undefined) return ISSUE_ACTION_MALFORMED;
  const binding = { issueId: input.issueId, baseUrl };
  if (response.items.some((row) => !pinnedParentMatches(row, binding))) return ISSUE_ACTION_MALFORMED;
  return { ok: true, value: projected.some((item) => item.id === input.commentId) };
}
export async function admitIssueAction(request: JiraMutationRequest, input: IssueActionInput, baseUrl?: string): Promise<IssueActionFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  if (input.kind === "pin") return bindPinComment(request, input, baseUrl);
  const parent = await bindLinkIssue(request, input.issueId);
  if (!parent.ok) return parent;
  if (parent.value.id !== input.issueId || parent.value.key !== input.issueKey) return issueActionRefusal("The exact reviewed issue ID/key no longer matches. No notification was requested.", "conflict");
  return bindRolePrincipals(request, { users: input.users, groups: [] });
}
