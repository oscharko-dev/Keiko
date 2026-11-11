import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { agileDate } from "./jira-agile-projection.js";
import { jiraCommentVisibility } from "./jira-comment-visibility.js";
import { readJiraCompleteWorklogs } from "./jira-managed-issue-details.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import {
  matchesJiraWorklog,
  readJiraBoundWorklog,
  type JiraBoundWorklog,
} from "./jira-managed-worklog-mutations.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { gateJiraWorklogChange } from "./jira-worklog-templates.js";

type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
interface Input {
  readonly issueKey: string;
  readonly worklogId: string;
  readonly expected: JiraBoundWorklog;
}
interface Bound {
  readonly issueId: string;
  readonly issueKey: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly current: JiraBoundWorklog;
}
const ALLOWED = new Set([
  "issueKey",
  "worklogId",
  "timeSpentSeconds",
  "started",
  "comment",
  "visibility",
]);
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };
function expected(args: CatalogJsonObject): JiraBoundWorklog | undefined {
  const visibility = jiraCommentVisibility(args.visibility);
  if (
    args.visibility === undefined ||
    visibility === undefined ||
    !jiraNativeText(args.comment, 32768, true) ||
    !agileDate(args.started) ||
    typeof args.timeSpentSeconds !== "number" ||
    !Number.isSafeInteger(args.timeSpentSeconds) ||
    args.timeSpentSeconds < 0
  )
    return undefined;
  return {
    comment: args.comment,
    started: args.started,
    timeSpentSeconds: args.timeSpentSeconds,
    visibility,
  };
}
function input(args: CatalogJsonObject): Input | undefined {
  const snapshot = expected(args);
  return snapshot !== undefined &&
    isSafeAtlassianIdentifier(args.issueKey) &&
    jiraNativeId(args.worklogId) &&
    Object.keys(args).every((key) => ALLOWED.has(key))
    ? { issueKey: args.issueKey, worklogId: args.worklogId, expected: snapshot }
    : undefined;
}
export function isJiraWorklogDelete(name: string): name is "jira.delete-worklog" {
  return name === "jira.delete-worklog";
}
function collectionMatches(
  item: CatalogJsonObject | undefined,
  current: JiraBoundWorklog,
): boolean {
  const comment = item?.comment ?? "";
  if (
    item === undefined ||
    typeof comment !== "string" ||
    typeof item.started !== "string" ||
    typeof item.timeSpentSeconds !== "number"
  )
    return false;
  return matchesJiraWorklog(
    {
      comment,
      started: item.started,
      timeSpentSeconds: item.timeSpentSeconds,
      visibility: current.visibility,
    },
    current,
    current.visibility,
  );
}
async function bind(
  request: JiraMutationRequest,
  selected: Input,
): Promise<Failure | { readonly ok: true; readonly bound: Bound }> {
  const issue = await readJiraMutationIssue(request, selected.issueKey, [
    "summary",
    "timespent",
    "timetracking",
  ]);
  if (!issue.ok) return issue;
  if (!jiraNativeId(issue.id) || !isSafeAtlassianIdentifier(issue.key)) return MALFORMED;
  const read = await readJiraBoundWorklog(request, issue.id, selected.worklogId);
  if (!read.ok) return read;
  if (!matchesJiraWorklog(read.worklog, selected.expected, selected.expected.visibility))
    return {
      ...CONFLICT,
      detail: {
        messages: [
          "The worklog changed after its time, comment or visibility was reviewed. Inspect and approve its current fields before deleting it.",
        ],
      },
    };
  const collection = await readJiraCompleteWorklogs(request, { id: issue.id, key: issue.key });
  if (!collection.ok) return collection;
  if (
    !collectionMatches(
      collection.items.find((item) => item.id === selected.worklogId),
      read.worklog,
    )
  )
    return CONFLICT;
  return {
    ok: true,
    bound: { issueId: issue.id, issueKey: issue.key, fields: issue.fields, current: read.worklog },
  };
}
async function confirm(
  request: JiraMutationRequest,
  bound: Bound,
  receipt: JiraMutationReceipt & { readonly worklogId: string },
): Promise<JiraMutationAttempt> {
  try {
    const issue = await readJiraMutationIssue(request, bound.issueId, ["summary"]);
    if (!issue.ok) return { ...issue, receipt };
    if (issue.id !== bound.issueId || issue.key !== bound.issueKey) return { ...CONFLICT, receipt };
    const collection = await readJiraCompleteWorklogs(request, {
      id: bound.issueId,
      key: bound.issueKey,
    });
    if (!collection.ok) return { ...collection, receipt };
    return collection.items.some((item) => item.id === receipt.worklogId)
      ? { ...CONFLICT, receipt }
      : { ok: true, receipt };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** Delete one reviewed entry, retaining estimates and using the existing complete-collection owner. */
export async function executeJiraWorklogDelete(
  _operation: "jira.delete-worklog",
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<JiraMutationAttempt> {
  const selected = input(args);
  if (selected === undefined)
    return {
      ok: false,
      reason: "field-validation",
      detail: {
        validation: "invalid-field",
        messages: [
          "Review the exact worklog ID, nonnegative whole seconds, zoned start time, native comment and visibility (null for unrestricted) before deletion.",
        ],
      },
    };
  const inspected = await bind(request, selected);
  if (!inspected.ok) return inspected;
  const { bound } = inspected;
  const gate = await gateJiraWorklogChange(
    request,
    templates,
    bound.issueId,
    bound.fields,
    -bound.current.timeSpentSeconds,
    bound.current.timeSpentSeconds,
  );
  if (!gate.ok) return gate;
  if (check) return { ok: true, receipt: {} };
  const receipt = {
    issueKey: bound.issueKey,
    issueId: bound.issueId,
    worklogId: selected.worklogId,
  };
  const response = await request(
    `issue/${bound.issueId}/worklog/${selected.worklogId}?adjustEstimate=leave`,
    "DELETE",
    undefined,
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt };
  return confirm(request, bound, receipt);
}
