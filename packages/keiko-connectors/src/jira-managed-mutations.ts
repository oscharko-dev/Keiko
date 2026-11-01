import {
  isSafeAtlassianIdentifier,
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
): Promise<MutationValidation> {
  const response = await request(path, method, body, "none");
  if (!response.ok) return dispatchFailure(response);
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
function createArgumentsValid(
  args: CatalogJsonObject,
  fields: Record<string, unknown> | undefined,
  links: readonly JiraIssueLinkRequest[] | undefined,
): boolean {
  return (
    keysAllowed(args, ["projectId", "issueTypeId", "fields", "links", "requirementIds"]) &&
    fields !== undefined &&
    links !== undefined &&
    !Object.keys(fields).some(isCreateRoutingField)
  );
}
async function createIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  policy: MutationPolicy,
  trace?: JiraTraceRequest,
): Promise<JiraMutationAttempt> {
  const { projectId, issueTypeId } = args;
  const fields = fieldsInput(args.fields);
  const links = parseJiraIssueLinks(args.links);
  if (
    !createArgumentsValid(args, fields, links) ||
    !numericId(projectId) ||
    !numericId(issueTypeId) ||
    fields === undefined ||
    links === undefined
  )
    return INVALID;
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
  const plan = planJiraIssueLinks(create.links);
  const response = await request("issue", "POST", {
    fields: validated.fields,
    update: linkedUpdate(validated, plan),
  });
  if (!response.ok) return dispatchFailure(response);
  return confirmCreatedIssue(request, response, metadata, withLinks(validated, create.links), plan);
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
/** The template gate in front of an edit or transition; `undefined` means the write may proceed. */
async function admitFieldMutation(
  request: JiraMutationRequest,
  metadata: readonly JiraFieldMetadata[],
  linked: Extract<LinkedFieldChanges, { ok: true }>,
  { purpose, issueKey, transition }: FieldTarget,
  policy: MutationPolicy,
): Promise<JiraMutationAttempt | undefined> {
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
  if (!gate.ok) return gate;
  return policy.check ? CHECKED : undefined;
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
  const values = withLinks(validated, linked.links);
  const admitted = await admitFieldMutation(request, metadata.fields, linked, fieldTarget, policy);
  if (admitted !== undefined) return admitted;
  const transitionId = purpose === "transition" ? transitionArgument(args) : undefined;
  const target = fieldMutationTarget(issueKey, transitionId);
  const prior = await readJiraMutationIssue(
    request,
    issueKey,
    jiraMutationFieldSelection(values, transitionId !== undefined),
  );
  if (!prior.ok) return prior;
  // Jira does not de-duplicate links: one already on the issue is not written again.
  const plan = planJiraIssueLinks(linked.links, prior.fields.issuelinks);
  const acknowledged = await statusMutation(request, target.path, target.method, {
    fields: validated.fields,
    update: linkedUpdate(validated, plan),
    ...target.body,
  });
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
function editArgumentsValid(args: CatalogJsonObject): boolean {
  const fields = fieldsInput(args.fields ?? {});
  const updates = asArray(args.updates ?? []);
  const links = parseJiraIssueLinks(args.links);
  return (
    keysAllowed(args, ["issueKey", "fields", "updates", "links", "requirementIds"]) &&
    fields !== undefined &&
    updates !== undefined &&
    links !== undefined &&
    Object.keys(fields).length + updates.length + links.length > 0
  );
}
async function editIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
  policy: MutationPolicy,
  trace?: JiraTraceRequest,
): Promise<JiraMutationAttempt> {
  if (!editArgumentsValid(args)) return INVALID;
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
  if (
    !keysAllowed(args, ["issueKey", "transitionId", "fields", "updates"]) ||
    !numericId(transitionId) ||
    fieldsInput(args.fields ?? {}) === undefined ||
    asArray(args.updates ?? []) === undefined
  )
    return INVALID;
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
    return validated.ok ? { ok: true } : INVALID;
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
  return uniqueActiveAssignee(users, name) ? { ok: true } : INVALID;
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
async function assignIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
): Promise<JiraMutationAttempt> {
  const name = assignmentName(args);
  if (name === undefined) return INVALID;
  const allowed = await checkAssignee(request, issueKey, name);
  if (!allowed.ok) return allowed;
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
  if (
    !keysAllowed(args, ["issueKey", "body"]) ||
    typeof body !== "string" ||
    body.trim().length === 0 ||
    body.length > 32768
  )
    return INVALID;
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
  if (parsed === undefined) return INVALID;
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
  const resolved = resolveJiraDraftItem(item, keys);
  const links = parseJiraIssueLinks(resolved?.links);
  const fields = fieldsInput(resolved?.fields);
  if (resolved === undefined || links === undefined || fields === undefined) return INVALID;
  const request = requestFor(connection, context);
  const metadata = await jiraCreateMutationMetadata(request, item.projectId, item.issueTypeId);
  if (!metadata.ok) return metadata;
  const found = await reconcileJiraDraftItem(
    request,
    item,
    metadata.fields,
    jiraDraftParentKey(item, keys),
  );
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
  if (!isSafeAtlassianIdentifier(issueKey)) return Promise.resolve(INVALID);
  switch (operation) {
    case "jira.edit":
      return editIssue(request, args, issueKey, policy, trace);
    case "jira.assign":
      return assignIssue(request, args, issueKey);
    case "jira.comment":
      return addComment(request, args, issueKey);
    case "jira.transition":
      return transitionIssue(request, args, issueKey, policy);
    default:
      return Promise.resolve(INVALID);
  }
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
  return dispatchMutation(
    operation,
    structuredClone(source),
    requestFor(connection, context),
    { templates: connection.issueTemplates, check: false },
    trace,
  );
}

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
  // Assignment and comments carry no field state; the check mode must never reach their write.
  if (
    connection.deployment !== "data-center" ||
    !(operation === "jira.create" || operation === "jira.edit" || operation === "jira.transition")
  )
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
