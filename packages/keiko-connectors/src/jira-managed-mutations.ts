import {
  isSafeAtlassianIdentifier,
  type JiraFieldValidationFailure,
  type JiraMutationAttempt,
  type JiraMutationOperation,
  type JiraFieldMetadata,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  asArray,
  asRecord,
  atlassianApiEndpointsFor,
  atlassianApiUrl,
} from "./atlassian-sync-classify.js";
import {
  ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS,
  executeAtlassianWriteRequest,
  type AtlassianWriteHttpOutcome,
} from "./atlassian-write-http.js";
import { validateJiraFieldChanges } from "./jira-field-metadata.js";
import { completeJiraLinkedMutation } from "./jira-issue-link-writes.js";
import {
  dispatchJiraAttachment,
  jiraAttachmentLimit,
  parseJiraAttachmentArguments,
  verifiedJiraAttachmentContent,
} from "./jira-attachments.js";
import {
  jiraIssueLinkAccount,
  jiraIssueLinkAdds,
  jiraIssueLinksOffered,
  parseJiraIssueLinks,
  planJiraIssueLinks,
  type JiraIssueLinkPlan,
  type JiraIssueLinkRequest,
} from "./jira-issue-links.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
import {
  jiraDraftIdentity,
  jiraDraftParentKey,
  reconcileJiraDraftItem,
  resolveJiraDraftItem,
  withJiraDraftIdentity,
  type JiraDraftItem,
} from "./jira-draft.js";
import {
  traceCreateFields,
  traceEditArguments,
  type JiraTraceRequest,
} from "./jira-requirement-trace.js";
import {
  jiraCreateMutationMetadata,
  jiraEditMutationMetadata,
  jiraTransitionMutationMetadata,
  type JiraMutationMetadata,
  type JiraMutationRequest,
} from "./jira-managed-mutation-metadata.js";

import {
  confirmJiraAssignment,
  confirmJiraComment,
  jiraMutationFieldSelection,
  readJiraMutationIssue,
  type JiraValidatedMutationFields,
} from "./jira-mutation-confirmation.js";

type MutationValidation = { readonly ok: true } | Extract<JiraMutationAttempt, { ok: false }>;
/** Templates govern the write; `check` stops after admission, before any POST or PUT. */
interface MutationPolicy {
  readonly templates: JiraIssueTemplateSource | undefined;
  readonly check: boolean;
}
const CHECKED: JiraMutationAttempt = { ok: true, receipt: {} };
const INVALID = { ok: false, reason: "field-validation" } as const;
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
/**
 * `requirementIds` mean a trace: the owner validates them against its Knowledge Pods and hands the
 * connector the resulting `trace`. A consumer with no resolver (a Coding run) passes none, so a
 * reference there would be accepted and silently untraced; it is refused instead, naming the field.
 */
const UNTRACED_REFERENCES: Extract<JiraMutationAttempt, { ok: false }> = {
  ok: false,
  reason: "field-validation",
  detail: {
    fieldId: "requirementIds",
    validation: "unsupported-field",
    messages: [
      "Requirement references cannot be traced in this session, so nothing was changed. Send the change again without requirementIds.",
    ],
  },
};
// eslint-disable-next-line no-control-regex -- HTTP reference values must not contain control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
/** Keiko's own pre-dispatch refusal names the field and the closed reason. */
function validationFailure(
  result: Extract<ReturnType<typeof validateJiraFieldChanges>, { ok: false }>,
): Extract<JiraMutationAttempt, { ok: false }> {
  return {
    ...INVALID,
    detail: {
      validation: result.reason,
      ...(result.fieldId === undefined ? {} : { fieldId: result.fieldId }),
      ...(result.message === undefined ? {} : { messages: [result.message] }),
    },
  };
}
type Validated = Extract<ReturnType<typeof validateJiraFieldChanges>, { ok: true }>;
/** Every requested link must read back from the issue; confirmation checks them all (#4176). */
function withLinks(
  validated: Validated,
  links: readonly JiraIssueLinkRequest[],
): JiraValidatedMutationFields {
  return links.length === 0 ? validated : { ...validated, links };
}
/** Jira takes one `issuelinks` operation per request, so only the plan's inline link rides here. */
function linkedUpdate(
  validated: Validated,
  plan: JiraIssueLinkPlan,
): Readonly<Record<string, unknown>> {
  return plan.inline.length === 0
    ? validated.update
    : { ...validated.update, issuelinks: jiraIssueLinkAdds(plan.inline) };
}
/** Links may only be requested when current metadata offers them. */
function linkOffer(
  metadata: readonly JiraFieldMetadata[],
  links: readonly JiraIssueLinkRequest[],
): Extract<JiraMutationAttempt, { ok: false }> | undefined {
  return links.length === 0 ? undefined : jiraIssueLinksOffered(metadata);
}
function numericId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,32}$/u.test(value);
}
function keysAllowed(args: CatalogJsonObject, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(args).every((key) => keys.has(key));
}
type Refusal = Extract<JiraMutationAttempt, { ok: false }>;
/**
 * Keiko's own refusal of a call's arguments names the argument and how to send it again: a bare
 * `field-validation` left Qwen retrying the same create three times (2026-11-01, #4173).
 */
function refusedArgument(
  fieldId: string | undefined,
  validation: JiraFieldValidationFailure,
  message: string,
): Refusal {
  return {
    ...INVALID,
    detail: {
      ...(fieldId === undefined ? {} : { fieldId }),
      validation,
      messages: [`${message} Nothing was changed.`],
    },
  };
}
/** One argument check: whether it holds, and the refusal that names it when it does not. */
type ArgumentCheck = readonly [
  holds: boolean,
  fieldId: string,
  validation: JiraFieldValidationFailure,
  message: string,
];
/** The first argument a call does not take, then the first check that fails, each by name. */
function argumentRefusal(
  args: CatalogJsonObject,
  allowed: readonly string[],
  checks: readonly ArgumentCheck[],
): Refusal | undefined {
  if (!keysAllowed(args, allowed))
    return refusedArgument(
      undefined,
      "unsupported-field",
      `This call takes only ${allowed.join(", ")}.`,
    );
  const failed = checks.find(([holds]) => !holds);
  return failed === undefined ? undefined : refusedArgument(failed[1], failed[2], failed[3]);
}
const FIELDS_SHAPE =
  "fields must be an object of field IDs and values, without project or issuetype.";
const LINKS_SHAPE = "links must be a list of {type, direction, issueKey}, at most 20.";
const UPDATES_SHAPE = "updates must be a list of label updates {fieldId, operation, value}.";
function fieldsInput(value: unknown): Record<string, unknown> | undefined {
  const fields = asRecord(value);
  return fields !== undefined &&
    !Object.hasOwn(fields, "project") &&
    !Object.hasOwn(fields, "issuetype")
    ? fields
    : undefined;
}
/** One bounded Jira request function over the composed transport; also used by read-only tools. */
export function requestFor(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraMutationRequest {
  const { http, baseUrl } = connection;
  const beforeEffect: () => unknown = context.beforeEffect;
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  const endpoints = atlassianApiEndpointsFor(baseUrl, "/rest/api/2/");
  return (path, method, body, expect, upload) =>
    executeAtlassianWriteRequest(
      {
        signal,
        http: (request) =>
          signal.aborted || beforeEffect() !== true
            ? Promise.resolve({ kind: "network-error" })
            : http(request),
      },
      {
        method: method ?? "GET",
        url: atlassianApiUrl(endpoints, path),
        expect: expect ?? "json",
        ...(body === undefined ? {} : { bodyJson: JSON.stringify(body) }),
        ...(upload === undefined ? {} : { upload }),
      },
    );
}
async function statusMutation(
  request: JiraMutationRequest,
  path: string,
  method: "POST" | "PUT",
  body: Readonly<Record<string, unknown>>,
  metadata: readonly JiraFieldMetadata[] = [],
): Promise<MutationValidation> {
  const response = await request(path, method, body, "none");
  if (!response.ok) return dispatchFailure(response, metadata);
  return response.status === 204 ? { ok: true } : MALFORMED;
}
function isCreateRoutingField(id: string): boolean {
  return id === "project" || id === "issuetype";
}
function createContextFields(fields: readonly JiraFieldMetadata[]): readonly JiraFieldMetadata[] {
  // Jira may mark the endpoint-selected issue type immutable. Only canonical routing
  // values are inserted here; ordinary fields retain their advertised operations.
  return fields.map((field) =>
    isCreateRoutingField(field.id) && field.operations.length === 0
      ? { ...field, operations: ["set"] }
      : field,
  );
}
/** A routing field inside `fields` that restates the call's own numeric identity, and nothing else. */
function restatesRouting(value: unknown, id: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && Object.keys(record).length === 1 && record.id === id;
}
function routingOverride(fieldId: string): Extract<JiraMutationAttempt, { ok: false }> {
  return {
    ...INVALID,
    detail: {
      fieldId,
      validation: "invalid-field",
      messages: [
        `${fieldId} is chosen by projectId and issueTypeId, so nothing was changed. Send the change again without ${fieldId} in fields.`,
      ],
    },
  };
}
/**
 * The create's `fields` without a routing field that only repeats `projectId` or `issueTypeId`: a
 * model that writes `project: { id: projectId }` beside `projectId` asks for the same issue. A
 * routing field naming anything else would override the routing and is refused by name.
 */
function withoutRestatedRouting(
  args: CatalogJsonObject,
): { readonly ok: true; readonly fields: unknown } | Extract<JiraMutationAttempt, { ok: false }> {
  const fields = asRecord(args.fields);
  if (fields === undefined) return { ok: true, fields: args.fields };
  const routing: Readonly<Record<string, unknown>> = {
    project: args.projectId,
    issuetype: args.issueTypeId,
  };
  const overridden = Object.keys(routing).find(
    (id) => Object.hasOwn(fields, id) && !restatesRouting(fields[id], routing[id]),
  );
  if (overridden !== undefined) return routingOverride(overridden);
  return {
    ok: true,
    fields: Object.fromEntries(
      Object.entries(fields).filter(([id]) => !Object.hasOwn(routing, id)),
    ),
  };
}
function createArgumentsRefusal(
  args: CatalogJsonObject,
  fields: Record<string, unknown> | undefined,
  links: readonly JiraIssueLinkRequest[] | undefined,
): Refusal | undefined {
  return argumentRefusal(
    args,
    ["projectId", "issueTypeId", "fields", "links", "requirementIds"],
    [
      [
        numericId(args.projectId),
        "projectId",
        "required-field",
        "projectId must be the numeric project ID jira.projects returns.",
      ],
      [
        numericId(args.issueTypeId),
        "issueTypeId",
        "required-field",
        "issueTypeId must be the numeric issue-type ID jira.issue_types returns.",
      ],
      [
        fields !== undefined && !Object.keys(fields).some(isCreateRoutingField),
        "fields",
        "invalid-field",
        FIELDS_SHAPE,
      ],
      [links !== undefined, "links", "invalid-field", LINKS_SHAPE],
    ],
  );
}
async function createIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  policy: MutationPolicy,
  trace?: JiraTraceRequest,
): Promise<JiraMutationAttempt> {
  const { projectId, issueTypeId } = args;
  const routed = withoutRestatedRouting(args);
  if (!routed.ok) return routed;
  const fields = fieldsInput(routed.fields);
  const links = parseJiraIssueLinks(args.links);
  const refused = createArgumentsRefusal(args, fields, links);
  if (refused !== undefined) return refused;
  // Narrowing only: the refusal above already named every argument these reject.
  if (!numericId(projectId) || !numericId(issueTypeId) || fields === undefined) return INVALID;
  if (links === undefined) return INVALID;
  const metadata = await jiraCreateMutationMetadata(request, projectId, issueTypeId);
  if (!metadata.ok) return metadata;
  const traced = trace === undefined ? fields : traceCreateFields(fields, metadata.fields, trace);
  return createWithMetadata(
    request,
    { projectId, issueTypeId, fields: traced, links },
    metadata.fields,
    policy,
  );
}
interface CreateRequest {
  readonly projectId: string;
  readonly issueTypeId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly links: readonly JiraIssueLinkRequest[];
}
async function createWithMetadata(
  request: JiraMutationRequest,
  create: CreateRequest,
  metadata: readonly JiraFieldMetadata[],
  policy: MutationPolicy,
): Promise<JiraMutationAttempt> {
  const validated = validateJiraFieldChanges(
    createContextFields(metadata),
    { ...create.fields, project: { id: create.projectId }, issuetype: { id: create.issueTypeId } },
    "create",
    "data-center",
  );
  if (!validated.ok) return validationFailure(validated);
  const refused = linkOffer(metadata, create.links);
  if (refused !== undefined) return refused;
  const gate = await gateJiraMutationByTemplates({
    request,
    source: policy.templates,
    operation: "create",
    metadata,
    validated,
    links: create.links,
    target: { projectId: create.projectId, issueTypeId: create.issueTypeId },
  });
  if (!gate.ok) return gate;
  if (policy.check) return CHECKED;
  // The link a template requires rides on the create itself, never on a later call.
  const links = gate.links ?? create.links;
  const plan = planJiraIssueLinks(links);
  const response = await request("issue", "POST", {
    fields: validated.fields,
    update: linkedUpdate(validated, plan),
  });
  if (!response.ok) return dispatchFailure(response, metadata);
  return confirmCreatedIssue(request, response, metadata, withLinks(validated, links), plan);
}
function confirmCreatedIssue(
  request: JiraMutationRequest,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  metadata: readonly JiraFieldMetadata[],
  values: JiraValidatedMutationFields,
  plan: JiraIssueLinkPlan,
): Promise<JiraMutationAttempt> {
  const { key, id } = response.body ?? {};
  if (response.status !== 201 || !isSafeAtlassianIdentifier(key) || !numericId(id))
    return Promise.resolve(MALFORMED);
  return completeJiraLinkedMutation(
    request,
    { issueKey: key, receipt: { issueKey: key, issueId: id }, metadata, values },
    plan,
  );
}
interface FieldMutationTarget {
  readonly path: string;
  readonly method: "POST" | "PUT";
  readonly body: Readonly<Record<string, unknown>>;
  readonly receipt: JiraMutationReceipt;
}
function fieldMutationTarget(
  issueKey: string,
  transitionId: string | undefined,
): FieldMutationTarget {
  const path = `issue/${encodeURIComponent(issueKey)}`;
  return transitionId === undefined
    ? { path, method: "PUT", body: {}, receipt: { issueKey } }
    : {
        path: `${path}/transitions`,
        method: "POST",
        body: { transition: { id: transitionId } },
        receipt: { issueKey, transitionId },
      };
}
function transitionArgument(args: CatalogJsonObject): string | undefined {
  return typeof args.transitionId === "string" ? args.transitionId : undefined;
}
type LinkedFieldChanges =
  | {
      readonly ok: true;
      readonly validated: Validated;
      readonly links: readonly JiraIssueLinkRequest[];
    }
  | Extract<JiraMutationAttempt, { ok: false }>;
function linkedFieldChanges(
  fields: readonly JiraFieldMetadata[],
  args: CatalogJsonObject,
  purpose: "edit" | "transition",
): LinkedFieldChanges {
  const validated = validateJiraFieldChanges(
    fields,
    args.fields ?? {},
    purpose,
    "data-center",
    args.updates ?? [],
  );
  if (!validated.ok) return validationFailure(validated);
  const links = parseJiraIssueLinks(args.links) ?? [];
  return linkOffer(fields, links) ?? { ok: true, validated, links };
}
interface FieldTarget {
  readonly purpose: "edit" | "transition";
  readonly issueKey: string;
  readonly targetStatusId?: string;
  readonly transition?: {
    readonly id: string;
    readonly name?: string;
    readonly targetStatusName?: string;
  };
}
/** The template gate in front of an edit or transition: the attempt that stops it, or the links to send. */
type FieldAdmission =
  { readonly stop: JiraMutationAttempt } | { readonly links: readonly JiraIssueLinkRequest[] };
async function admitFieldMutation(
  request: JiraMutationRequest,
  metadata: readonly JiraFieldMetadata[],
  linked: Extract<LinkedFieldChanges, { ok: true }>,
  { purpose, issueKey, transition }: FieldTarget,
  policy: MutationPolicy,
): Promise<FieldAdmission> {
  const gate = await gateJiraMutationByTemplates({
    request,
    source: policy.templates,
    operation: purpose,
    metadata,
    validated: linked.validated,
    links: linked.links,
    target: { issueKey },
    ...(transition === undefined ? {} : { transition }),
  });
  if (!gate.ok) return { stop: gate };
  return policy.check ? { stop: CHECKED } : { links: gate.links ?? linked.links };
}
async function fieldMutation(
  request: JiraMutationRequest,
  metadata: JiraMutationMetadata,
  args: CatalogJsonObject,
  fieldTarget: FieldTarget,
  policy: MutationPolicy,
): Promise<JiraMutationAttempt> {
  const { purpose, issueKey, targetStatusId } = fieldTarget;
  if (!metadata.ok) return metadata;
  const linked = linkedFieldChanges(metadata.fields, args, purpose);
  if (!linked.ok) return linked;
  const { validated } = linked;
  const admitted = await admitFieldMutation(request, metadata.fields, linked, fieldTarget, policy);
  if ("stop" in admitted) return admitted.stop;
  const values = withLinks(validated, admitted.links);
  const transitionId = purpose === "transition" ? transitionArgument(args) : undefined;
  const target = fieldMutationTarget(issueKey, transitionId);
  const prior = await readJiraMutationIssue(
    request,
    issueKey,
    jiraMutationFieldSelection(values, transitionId !== undefined),
  );
  if (!prior.ok) return prior;
  // Jira does not de-duplicate links: one already on the issue is not written again.
  const plan = planJiraIssueLinks(admitted.links, prior.fields.issuelinks);
  const acknowledged = await statusMutation(
    request,
    target.path,
    target.method,
    { fields: validated.fields, update: linkedUpdate(validated, plan), ...target.body },
    metadata.fields,
  );
  if (!acknowledged.ok) return acknowledged;
  return completeJiraLinkedMutation(
    request,
    {
      issueKey,
      receipt: target.receipt,
      metadata: metadata.fields,
      values,
      prior,
      ...(targetStatusId === undefined ? {} : { targetStatusId }),
    },
    plan,
  );
}
function editArgumentsRefusal(args: CatalogJsonObject): Refusal | undefined {
  const fields = fieldsInput(args.fields ?? {});
  const updates = asArray(args.updates ?? []);
  const links = parseJiraIssueLinks(args.links);
  const changes = Object.keys(fields ?? {}).length + (updates?.length ?? 0) + (links?.length ?? 0);
  return argumentRefusal(
    args,
    ["issueKey", "fields", "updates", "links", "requirementIds"],
    [
      [fields !== undefined, "fields", "invalid-field", FIELDS_SHAPE],
      [updates !== undefined, "updates", "invalid-field", UPDATES_SHAPE],
      [links !== undefined, "links", "invalid-field", LINKS_SHAPE],
      [
        changes > 0,
        "fields",
        "required-field",
        "The edit names no change: send at least one field, label update or link.",
      ],
    ],
  );
}
async function editIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
  policy: MutationPolicy,
  trace?: JiraTraceRequest,
): Promise<JiraMutationAttempt> {
  const refused = editArgumentsRefusal(args);
  if (refused !== undefined) return refused;
  const metadata = await jiraEditMutationMetadata(request, issueKey);
  const target = { purpose: "edit", issueKey } as const;
  if (trace === undefined || !metadata.ok)
    return fieldMutation(request, metadata, args, target, policy);
  const traced = await traceEditArguments(request, issueKey, args, metadata.fields, trace);
  if (!traced.ok) return traced.attempt;
  return fieldMutation(request, metadata, traced.args, target, policy);
}
async function transitionIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
  policy: MutationPolicy,
): Promise<JiraMutationAttempt> {
  const transitionId = args.transitionId;
  const refused = argumentRefusal(
    args,
    ["issueKey", "transitionId", "fields", "updates"],
    [
      [
        numericId(transitionId),
        "transitionId",
        "required-field",
        "transitionId must be the numeric ID jira.transitions returns for this issue.",
      ],
      [fieldsInput(args.fields ?? {}) !== undefined, "fields", "invalid-field", FIELDS_SHAPE],
      [asArray(args.updates ?? []) !== undefined, "updates", "invalid-field", UPDATES_SHAPE],
    ],
  );
  if (refused !== undefined) return refused;
  if (!numericId(transitionId)) return INVALID;
  const metadata = await jiraTransitionMutationMetadata(request, issueKey, transitionId);
  if (!metadata.ok) return metadata;
  return fieldMutation(
    request,
    metadata,
    args,
    {
      purpose: "transition",
      issueKey,
      targetStatusId: metadata.targetStatusId,
      transition: {
        id: transitionId,
        ...(metadata.transitionName === undefined ? {} : { name: metadata.transitionName }),
        ...(metadata.targetStatusName === undefined
          ? {}
          : { targetStatusName: metadata.targetStatusName }),
      },
    },
    policy,
  );
}
function userName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !CONTROL.test(value)
  );
}
async function checkAssignee(
  request: JiraMutationRequest,
  issueKey: string,
  name: string | null,
): Promise<MutationValidation> {
  if (name === null) {
    const metadata = await jiraEditMutationMetadata(request, issueKey);
    if (!metadata.ok) return metadata;
    const validated = validateJiraFieldChanges(
      metadata.fields,
      { assignee: null },
      "edit",
      "data-center",
    );
    return validated.ok ? { ok: true } : validationFailure(validated);
  }
  const params = new URLSearchParams({ issueKey, username: name, startAt: "0", maxResults: "100" });
  const response = await request(
    `user/assignable/search?${params.toString()}`,
    "GET",
    undefined,
    "json-array",
  );
  if (!response.ok) return response;
  const users = response.items;
  if (response.status !== 200 || users === undefined || users.length > 100) return MALFORMED;
  return uniqueActiveAssignee(users, name)
    ? { ok: true }
    : refusedArgument(
        "assigneeName",
        "invalid-field",
        "assigneeName must be the exact user name of one active user jira.assignable_users returns.",
      );
}
function uniqueActiveAssignee(users: readonly unknown[], name: string): boolean {
  const matches = users.map(asRecord).filter((user) => user?.name === name);
  return matches.length === 1 && matches[0]?.active === true;
}

function assignmentName(args: CatalogJsonObject): string | null | undefined {
  if (!keysAllowed(args, ["issueKey", "assigneeName", "clearAssignee"])) return undefined;
  if (args.clearAssignee === true && args.assigneeName === undefined) return null;
  return args.clearAssignee === undefined && userName(args.assigneeName)
    ? args.assigneeName
    : undefined;
}
/**
 * An assignment changes the `assignee` field, so it is an edit for the issue templates (#4177): the
 * state after it is judged by the same gate as `jira.edit`, and a refusal sends nothing.
 */
async function admitAssignment(
  request: JiraMutationRequest,
  issueKey: string,
  name: string | null,
  policy: MutationPolicy,
): Promise<JiraTemplateGateResult> {
  return gateJiraMutationByTemplates({
    request,
    source: policy.templates,
    operation: "edit",
    metadata: [],
    validated: { fields: { assignee: name === null ? null : { name } }, update: {} },
    target: { issueKey },
  });
}
async function assignIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
  policy: MutationPolicy,
): Promise<JiraMutationAttempt> {
  const name = assignmentName(args);
  if (name === undefined)
    return (
      argumentRefusal(
        args,
        ["issueKey", "assigneeName", "clearAssignee"],
        [
          [
            false,
            "assigneeName",
            "required-field",
            "Send assigneeName as one exact user name, or clearAssignee true without assigneeName.",
          ],
        ],
      ) ?? INVALID
    );
  const allowed = await checkAssignee(request, issueKey, name);
  if (!allowed.ok) return allowed;
  const gate = await admitAssignment(request, issueKey, name, policy);
  if (!gate.ok) return gate;
  if (policy.check) return CHECKED;
  const prior = await readJiraMutationIssue(request, issueKey, ["assignee"]);
  if (!prior.ok) return prior;
  const acknowledged = await statusMutation(
    request,
    `issue/${encodeURIComponent(issueKey)}/assignee`,
    "PUT",
    { name },
  );
  return acknowledged.ok ? confirmJiraAssignment(request, issueKey, name, prior) : acknowledged;
}
async function addComment(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
): Promise<JiraMutationAttempt> {
  const body = args.body;
  const refused = argumentRefusal(
    args,
    ["issueKey", "body"],
    [
      [
        typeof body === "string" && body.trim().length > 0 && body.length <= 32768,
        "body",
        "required-field",
        "body must be the comment text, not empty and at most 32768 characters.",
      ],
    ],
  );
  if (refused !== undefined) return refused;
  if (typeof body !== "string") return INVALID;
  const response = await request(`issue/${encodeURIComponent(issueKey)}/comment`, "POST", { body });
  if (!response.ok) return dispatchFailure(response);
  const id = response.body?.id;
  return response.status === 201 && numericId(id)
    ? confirmJiraComment(request, issueKey, id, body)
    : MALFORMED;
}

/**
 * The upload limit the instance reports for attachments, read before a file is reviewed so the
 * review and the send hold the file to the same bound (#4176). Read-only.
 */
export async function readJiraAttachmentLimit(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): Promise<{ readonly ok: true; readonly maxBytes: number } | { readonly ok: false }> {
  if (connection.deployment !== "data-center") return { ok: false };
  const limit = await jiraAttachmentLimit(requestFor(connection, context));
  return limit.ok ? limit : { ok: false };
}

/**
 * Attach one governed file (#4176): the instance's own limit bounds the read, the owner's source
 * port supplies the bytes, and Jira's stored attachment is read back before success is claimed.
 */
async function attachFile(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  connection: JiraManagedConnection,
): Promise<JiraMutationAttempt> {
  const parsed = parseJiraAttachmentArguments(args);
  if (parsed === undefined)
    return refusedArgument(
      "source",
      "invalid-field",
      "Send issueKey, source {kind, path} with a workspace-relative path, and an optional file name.",
    );
  if (connection.attachmentSource === undefined) return { ok: false, reason: "unavailable" };
  const limit = await jiraAttachmentLimit(request);
  if (!limit.ok) return limit;
  const read = await connection.attachmentSource({
    kind: "connected-file",
    path: parsed.path,
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    maxBytes: limit.maxBytes,
  });
  if (!read.ok)
    return {
      ok: false,
      reason: read.reason,
      ...(read.detail === undefined ? {} : { detail: read.detail }),
    };
  const refused = verifiedJiraAttachmentContent(read.content, limit.maxBytes);
  if (refused !== undefined) return refused;
  return dispatchJiraAttachment(request, {
    issueKey: parsed.issueKey,
    content: read.content,
    name: parsed.name ?? read.content.name,
  });
}

const EXISTING_LINKS_MISSING =
  "This issue already exists from this draft, but not every requested link is on it. Nothing was sent again; add only the missing links with jira.edit.";
/**
 * An item reconciled to an issue it already created is complete only when that issue also carries
 * the relations the item asks for: a create followed by a failed further link leaves an issue the
 * identity alone would pass off as done. The relations are read back, never written again; a
 * missing or unreadable one is a refusal that names the issue and the links still missing.
 */
async function existingItemWithLinks(
  request: JiraMutationRequest,
  existing: JiraMutationAttempt,
  links: readonly JiraIssueLinkRequest[],
): Promise<JiraMutationAttempt> {
  const issueKey = existing.ok ? existing.receipt.issueKey : undefined;
  if (!existing.ok || issueKey === undefined || links.length === 0) return existing;
  const current = await readJiraMutationIssue(request, issueKey, ["issuelinks"]);
  const entries = current.ok ? asArray(current.fields.issuelinks ?? []) : undefined;
  const account = jiraIssueLinkAccount(links, entries, 0);
  if (account.missing.length === 0) return { ...existing, links: account };
  return {
    ok: false,
    reason: current.ok ? "conflict" : current.reason,
    detail: { messages: [EXISTING_LINKS_MISSING] },
    receipt: existing.receipt,
    links: account,
  };
}

type DraftItemInput =
  | {
      readonly ok: true;
      readonly links: readonly JiraIssueLinkRequest[];
      readonly fields: Record<string, unknown>;
    }
  | Extract<JiraMutationAttempt, { ok: false }>;
/** The item's relations resolved to keys and its fields, or the refusal of an item that cannot run. */
function draftItemInput(
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
  trace: JiraTraceRequest | undefined,
): DraftItemInput {
  const resolved = resolveJiraDraftItem(item, keys);
  const links = parseJiraIssueLinks(resolved?.links);
  const fields = fieldsInput(resolved?.fields);
  if (resolved === undefined || links === undefined || fields === undefined)
    return refusedArgument(
      undefined,
      "invalid-field",
      "This draft item's fields, links or parent could not be resolved.",
    );
  if (trace === undefined && item.requirementIds !== undefined) return UNTRACED_REFERENCES;
  return { ok: true, links, fields };
}

/**
 * One backlog-draft item (#4178): its relations resolved to the keys earlier items received, then
 * reconciled against the issue its draft identity already names before anything is created.
 * A reconciled item sends no mutation; the server's journal records that nothing was dispatched.
 */
export async function executeJiraDraftItem(
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  trace?: JiraTraceRequest,
): Promise<JiraMutationAttempt> {
  if (connection.deployment !== "data-center") return { ok: false, reason: "unavailable" };
  const input = draftItemInput(item, keys, trace);
  if (!input.ok) return input;
  const { links, fields } = input;
  const request = requestFor(connection, context);
  const metadata = await jiraCreateMutationMetadata(request, item.projectId, item.issueTypeId);
  if (!metadata.ok) return metadata;
  const found = await reconcileJiraDraftItem(
    request,
    item,
    metadata.fields,
    jiraDraftParentKey(item, keys),
  );
  if (found.kind === "existing") return existingItemWithLinks(request, found.attempt, links);
  if (found.kind !== "absent") return found.attempt;
  const identified = withJiraDraftIdentity(fields, metadata.fields, jiraDraftIdentity(item));
  const traced =
    trace === undefined ? identified : traceCreateFields(identified, metadata.fields, trace);
  return createWithMetadata(
    request,
    { projectId: item.projectId, issueTypeId: item.issueTypeId, fields: traced, links },
    metadata.fields,
    { templates: connection.issueTemplates, check: false },
  );
}

/**
 * Read-only: the issue a draft item already created or reconciled to, found by its draft
 * identity. A replayed item keeps its journal outcome but not its receipt, so this recovers the
 * key its dependents need. `keys` are the keys its earlier items received.
 */
export async function findJiraDraftItem(
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraMutationAttempt> {
  if (connection.deployment !== "data-center") return { ok: false, reason: "unavailable" };
  const request = requestFor(connection, context);
  const metadata = await jiraCreateMutationMetadata(request, item.projectId, item.issueTypeId);
  if (!metadata.ok) return metadata;
  const found = await reconcileJiraDraftItem(
    request,
    item,
    metadata.fields,
    jiraDraftParentKey(item, keys),
  );
  return found.kind === "absent" ? { ok: false, reason: "not-found" } : found.attempt;
}

function dispatchMutation(
  operation: JiraMutationOperation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  policy: MutationPolicy,
  trace?: JiraTraceRequest,
): Promise<JiraMutationAttempt> {
  if (operation === "jira.create") return createIssue(request, args, policy, trace);
  const issueKey = args.issueKey;
  if (!isSafeAtlassianIdentifier(issueKey))
    return Promise.resolve(
      refusedArgument(
        "issueKey",
        "required-field",
        "issueKey must be one issue key such as ABC-123.",
      ),
    );
  switch (operation) {
    case "jira.edit":
      return editIssue(request, args, issueKey, policy, trace);
    case "jira.assign":
      return assignIssue(request, args, issueKey, policy);
    case "jira.comment":
      return addComment(request, args, issueKey);
    case "jira.transition":
      return transitionIssue(request, args, issueKey, policy);
    default:
      return Promise.resolve(INVALID);
  }
}

function untracedReferences(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  trace: JiraTraceRequest | undefined,
): boolean {
  return (
    trace === undefined &&
    source.requirementIds !== undefined &&
    (operation === "jira.create" || operation === "jira.edit")
  );
}

/** Fresh capability metadata and one mutation request. Durability/authority remain server-owned. */
export function executeJiraManagedMutation(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  trace?: JiraTraceRequest,
): Promise<JiraMutationAttempt> {
  if (connection.deployment !== "data-center")
    return Promise.resolve({ ok: false, reason: "unavailable" });
  // An attachment changes no field a template describes: it takes no template check.
  if (operation === "jira.attach")
    return attachFile(requestFor(connection, context), structuredClone(source), connection);
  if (untracedReferences(operation, source, trace)) return Promise.resolve(UNTRACED_REFERENCES);
  return dispatchMutation(
    operation,
    structuredClone(source),
    requestFor(connection, context),
    { templates: connection.issueTemplates, check: false },
    trace,
  );
}

const TEMPLATE_CHECKED: ReadonlySet<JiraMutationOperation> = new Set([
  "jira.create",
  "jira.edit",
  "jira.transition",
  "jira.assign",
]);
/**
 * The same admission pipeline without the write: Chat runs it before asking a human to approve, so
 * a draft that violates an active template is refused instead of being put in front of a person.
 * It reads and validates only; it never issues a POST or PUT.
 */
export async function checkJiraManagedMutationTemplates(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraTemplateGateResult> {
  // Comments carry no field state; the check mode must never reach any write.
  if (connection.deployment !== "data-center" || !TEMPLATE_CHECKED.has(operation))
    return { ok: true };
  const attempt = await dispatchMutation(
    operation,
    structuredClone(source),
    requestFor(connection, context),
    { templates: connection.issueTemplates, check: true },
  );
  if (attempt.ok || attempt.violations === undefined) return { ok: true };
  return { ok: false, reason: attempt.reason, violations: attempt.violations };
}
