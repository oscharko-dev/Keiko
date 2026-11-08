import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { agileDate, agileIssueKey } from "./jira-agile-projection.js";
import { normalizeJiraCommentBody } from "./jira-comment-binding.js";
import {
  jiraCommentVisibility,
  sameJiraCommentVisibility,
  type JiraCommentVisibility,
} from "./jira-comment-visibility.js";
import { jiraCreationAcknowledgement } from "./jira-creation-acknowledgement.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { gateJiraWorklogChange } from "./jira-worklog-templates.js";

type Operation = "jira.create-worklog" | "jira.update-worklog";
type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
interface WorklogFields {
  readonly comment?: string;
  readonly started?: string;
  readonly timeSpentSeconds?: number;
}
interface Input {
  readonly issueKey: string;
  readonly worklogId?: string;
  readonly fields: WorklogFields;
  readonly visibility: JiraCommentVisibility | null;
}
export interface JiraBoundWorklog extends Required<WorklogFields> {
  readonly visibility: JiraCommentVisibility | null;
}
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };
const INVALID: Failure = {
  ok: false,
  reason: "field-validation",
  detail: {
    validation: "invalid-field",
    messages: [
      "Use a positive whole number of seconds, an explicit-zone started timestamp (at most 40 characters), and a native Jira comment of at most 32768 characters. Updates require at least one changed field and preserve visibility.",
    ],
  },
};
const MUTABLE = new Set(["comment", "started", "timeSpentSeconds"]);
export function isJiraWorklogMutation(name: string): name is Operation {
  return name === "jira.create-worklog" || name === "jira.update-worklog";
}
function validSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function parseFields(args: CatalogJsonObject): WorklogFields | undefined {
  if (
    (Object.hasOwn(args, "comment") && !jiraNativeText(args.comment, 32768, true)) ||
    (Object.hasOwn(args, "started") && !agileDate(args.started)) ||
    (Object.hasOwn(args, "timeSpentSeconds") && !validSeconds(args.timeSpentSeconds))
  )
    return undefined;
  return {
    ...(typeof args.comment === "string" ? { comment: args.comment } : {}),
    ...(typeof args.started === "string"
      ? { started: new Date(args.started).toISOString().replace("Z", "+0000") }
      : {}),
    ...(typeof args.timeSpentSeconds === "number"
      ? { timeSpentSeconds: args.timeSpentSeconds }
      : {}),
  };
}
const REQUIRED_FIELDS: Readonly<
  Record<Operation, (fields: WorklogFields, worklogId: unknown) => boolean>
> = {
  "jira.create-worklog": (fields) =>
    fields.started !== undefined && fields.timeSpentSeconds !== undefined,
  "jira.update-worklog": (fields, worklogId) =>
    jiraNativeId(worklogId) && Object.keys(fields).length > 0,
};
function input(operation: Operation, args: CatalogJsonObject): Input | undefined {
  const create = operation === "jira.create-worklog";
  if (
    !isSafeAtlassianIdentifier(args.issueKey) ||
    !Object.keys(args).every(
      (key) =>
        key === "issueKey" || MUTABLE.has(key) || key === (create ? "visibility" : "worklogId"),
    )
  )
    return undefined;
  const fields = parseFields(args);
  const visibility = jiraCommentVisibility(args.visibility);
  if (
    fields === undefined ||
    visibility === undefined ||
    (Object.hasOwn(args, "visibility") && visibility === null) ||
    !REQUIRED_FIELDS[operation](fields, args.worklogId)
  )
    return undefined;
  return {
    issueKey: args.issueKey,
    fields,
    visibility,
    ...(typeof args.worklogId === "string" ? { worklogId: args.worklogId } : {}),
  };
}
function worklogFields(raw: Readonly<Record<string, unknown>>): JiraBoundWorklog | undefined {
  const visibility = jiraCommentVisibility(raw.visibility);
  const comment = raw.comment ?? "";
  if (
    !jiraNativeText(comment, 32768, true) ||
    !agileDate(raw.started) ||
    typeof raw.timeSpentSeconds !== "number" ||
    !Number.isSafeInteger(raw.timeSpentSeconds) ||
    raw.timeSpentSeconds < 0 ||
    visibility === undefined
  )
    return undefined;
  return { comment, started: raw.started, timeSpentSeconds: raw.timeSpentSeconds, visibility };
}
export async function readJiraBoundWorklog(
  request: JiraMutationRequest,
  issueId: string,
  worklogId: string,
): Promise<Failure | { readonly ok: true; readonly worklog: JiraBoundWorklog }> {
  const response = await request(`issue/${issueId}/worklog/${worklogId}`);
  if (!response.ok) return dispatchFailure(response);
  const raw = response.body;
  if (
    response.status !== 200 ||
    raw === undefined ||
    !jiraNativeId(raw.id) ||
    !jiraNativeId(raw.issueId)
  )
    return MALFORMED;
  if (raw.id !== worklogId || raw.issueId !== issueId) return CONFLICT;
  const worklog = worklogFields(raw);
  return worklog === undefined ? MALFORMED : { ok: true, worklog };
}
export function matchesJiraWorklog(
  current: JiraBoundWorklog,
  desired: WorklogFields,
  visibility: JiraCommentVisibility | null,
): boolean {
  return (
    (desired.comment === undefined ||
      normalizeJiraCommentBody(current.comment) === normalizeJiraCommentBody(desired.comment)) &&
    (desired.started === undefined ||
      Date.parse(current.started) === Date.parse(desired.started)) &&
    (desired.timeSpentSeconds === undefined ||
      current.timeSpentSeconds === desired.timeSpentSeconds) &&
    sameJiraCommentVisibility(current.visibility, visibility)
  );
}
async function confirm(
  request: JiraMutationRequest,
  receipt: JiraMutationReceipt & { readonly issueId: string; readonly worklogId: string },
  desired: WorklogFields,
  visibility: JiraCommentVisibility | null,
): Promise<JiraMutationAttempt> {
  try {
    const read = await readJiraBoundWorklog(request, receipt.issueId, receipt.worklogId);
    if (!read.ok) return { ...read, receipt };
    const outcome = matchesJiraWorklog(read.worklog, desired, visibility)
      ? { ok: true as const }
      : CONFLICT;
    return { ...outcome, receipt };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function create(
  request: JiraMutationRequest,
  selected: Input,
  issueId: string,
): Promise<JiraMutationAttempt> {
  const context = { issueKey: selected.issueKey, issueId };
  const response = await request(`issue/${issueId}/worklog?adjustEstimate=leave`, "POST", {
    ...selected.fields,
    ...(selected.visibility === null ? {} : { visibility: { ...selected.visibility } }),
  });
  const ack = jiraCreationAcknowledgement(
    response,
    (id) => (jiraNativeId(id) ? id : undefined),
    context,
  );
  if (!ack.ok) return ack;
  return confirm(
    request,
    { ...context, worklogId: ack.id },
    { ...selected.fields, comment: selected.fields.comment ?? "" },
    selected.visibility,
  );
}
async function update(
  request: JiraMutationRequest,
  selected: Input,
  issueId: string,
  worklogId: string,
  prior: JiraBoundWorklog,
): Promise<JiraMutationAttempt> {
  const receipt = { issueKey: selected.issueKey, issueId, worklogId };
  const response = await request(
    `issue/${issueId}/worklog/${worklogId}?adjustEstimate=leave`,
    "PUT",
    {
      ...selected.fields,
      ...(prior.visibility === null ? {} : { visibility: { ...prior.visibility } }),
    },
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  const confirmed = await confirm(
    request,
    receipt,
    { ...prior, ...selected.fields },
    prior.visibility,
  );
  return response.body?.id !== undefined && response.body.id !== worklogId
    ? { ...CONFLICT, receipt }
    : confirmed;
}

interface Prepared {
  readonly ok: true;
  readonly issueId: string;
  readonly issueKey: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly prior: JiraBoundWorklog | undefined;
}
async function prepare(request: JiraMutationRequest, selected: Input): Promise<Failure | Prepared> {
  const issue = await readJiraMutationIssue(request, selected.issueKey, [
    "summary",
    "timespent",
    "timetracking",
  ]);
  if (!issue.ok) return issue;
  if (!jiraNativeId(issue.id) || !agileIssueKey(issue.key)) return MALFORMED;
  const before =
    selected.worklogId === undefined
      ? undefined
      : await readJiraBoundWorklog(request, issue.id, selected.worklogId);
  if (before !== undefined && !before.ok) return before;
  return {
    ok: true,
    issueId: issue.id,
    issueKey: issue.key,
    fields: issue.fields,
    prior: before?.worklog,
  };
}
function unchanged(selected: Input, prepared: Prepared): Failure | undefined {
  const { prior, issueId } = prepared;
  if (
    prior !== undefined &&
    selected.worklogId !== undefined &&
    matchesJiraWorklog(prior, selected.fields, prior.visibility)
  )
    return {
      ...CONFLICT,
      receipt: { issueKey: selected.issueKey, issueId, worklogId: selected.worklogId },
      detail: {
        unchanged: true,
        messages: ["The worklog already holds the requested values. Nothing was written."],
      },
    };
  return undefined;
}
function priorSeconds(prior: JiraBoundWorklog | undefined): number {
  return prior?.timeSpentSeconds ?? 0;
}
function deltaSeconds(selected: Input, prior: JiraBoundWorklog | undefined): number {
  return selected.fields.timeSpentSeconds === undefined
    ? 0
    : selected.fields.timeSpentSeconds - priorSeconds(prior);
}
/** The caller retains custody, one-use approval, activity evidence and durable no-replay ownership. */
export async function executeJiraWorklogMutation(
  operation: Operation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<JiraMutationAttempt> {
  const selected = input(operation, args);
  if (selected === undefined) return INVALID;
  const prepared = await prepare(request, selected);
  if (!prepared.ok) return prepared;
  const bound = { ...selected, issueKey: prepared.issueKey };
  const noop = unchanged(bound, prepared);
  if (noop !== undefined) return noop;
  const { issueId, fields, prior } = prepared;
  const gate = await gateJiraWorklogChange(
    request,
    templates,
    issueId,
    fields,
    deltaSeconds(selected, prior),
    priorSeconds(prior),
  );
  if (!gate.ok) return gate;
  if (check) return { ok: true, receipt: {} };
  return selected.worklogId === undefined || prior === undefined
    ? create(request, bound, issueId)
    : update(request, bound, issueId, selected.worklogId, prior);
}
