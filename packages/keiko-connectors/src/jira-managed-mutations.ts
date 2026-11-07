import { executeJiraScreenTabMutation, isJiraScreenTabMutation } from "./jira-managed-screen-tab-mutations.js";
import { executeJiraMonitoringMutation, isJiraMonitoringMutation } from "./jira-managed-monitoring-mutations.js";
import { executeJiraEntityPropertyMutation, isJiraEntityPropertyMutation } from "./jira-managed-entity-property-mutations.js";
import { jiraAgileRequest } from "./jira-agile-request.js";
import {
  executeJiraParticipationMutation,
  isJiraParticipationMutation,
} from "./jira-managed-participation.js";
import {
  executeJiraWorklogMutation,
  isJiraWorklogMutation,
} from "./jira-managed-worklog-mutations.js";
import { executeJiraCommentDelete, isJiraCommentDelete } from "./jira-managed-comment-delete.js";
import {
  executeJiraAttachmentMutation,
  isJiraAttachmentMutation,
} from "./jira-managed-attachment-mutations.js";
import { executeJiraWorklogDelete, isJiraWorklogDelete } from "./jira-managed-worklog-delete.js";
import {
  isSafeAtlassianIdentifier,
  type AtlassianConnectorWriteFailureReason,
  type JiraFieldValidationFailure,
  type JiraMutationAttempt,
  type JiraMutationOperation,
  type JiraFieldMetadata,
  type JiraMutationReceipt,
  type JiraMutationFailureDetail,
  type JiraTemplateViolation,
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
import {
  validateJiraFieldChanges,
  prepareJiraDescriptionFields,
  type JiraFieldValidationResult,
} from "./jira-field-metadata.js";
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
import { executeJiraProjectMutation, isJiraProjectMutation } from "./jira-managed-projects.js";
import {
  executeJiraComponentMutation,
  isJiraComponentMutation,
} from "./jira-managed-components.js";
import { executeJiraVersionMutation, isJiraVersionMutation } from "./jira-managed-versions.js";
import { executeJiraCommentMutation, isJiraCommentMutation } from "./jira-managed-comments.js";
import { isJiraAgileMutation } from "./jira-agile-inputs.js";
import { checkJiraAgileMutation, executeJiraAgileMutation } from "./jira-agile-mutations.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
import {
  jiraDraftDependencies,
  jiraDraftIdentity,
  jiraDraftParentKey,
  JIRA_DRAFT_STAND_IN_KEY,
  parseJiraDraft,
  reconcileJiraDraftItem,
  resolveJiraDraftItem,
  withJiraDraftIdentity,
  withoutRestatedJiraRouting,
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
  jiraAlreadyHeldRefusal,
  jiraAssignmentAlreadyHeld,
  jiraEditAlreadyHeld,
  jiraMutationFieldSelection,
  readJiraMutationIssue,
  type JiraIssueReadback,
  type JiraValidatedMutationFields,
} from "./jira-mutation-confirmation.js";

type MutationValidation = { readonly ok: true } | Extract<JiraMutationAttempt, { ok: false }>;
/** Templates govern the write; `check` stops after admission, before any POST or PUT. */
interface MutationPolicy {
  readonly templates: JiraIssueTemplateSource | undefined;
  readonly check: boolean;
  readonly descriptionConvertedHeadingCount?: number;
  readonly descriptionProjection?: "supported-markdown";
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
/** The one field name a model reliably puts in the wrong place; it is an argument, not a field. */
const REFERENCES_PLACE = "requirementIds goes beside fields, not inside them.";
// eslint-disable-next-line no-control-regex -- HTTP reference values must not contain control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
/** Keiko's own pre-dispatch refusal names the field and the closed reason. */
function validationFailure(
  result: Extract<ReturnType<typeof validateJiraFieldChanges>, { ok: false }>,
): Extract<JiraMutationAttempt, { ok: false }> {
  const message =
    result.message ?? (result.fieldId === "requirementIds" ? REFERENCES_PLACE : undefined);
  return {
    ...INVALID,
    detail: {
      validation: result.reason,
      ...(result.fieldId === undefined ? {} : { fieldId: result.fieldId }),
      ...(message === undefined ? {} : { messages: [message] }),
    },
  };
}
type Validated = Extract<ReturnType<typeof validateJiraFieldChanges>, { ok: true }>;
function withDescriptionFormatting(
  attempt: JiraMutationAttempt,
  metrics: Pick<CreateRequest, "descriptionConvertedHeadingCount" | "descriptionProjection">,
): JiraMutationAttempt {
  return { ...attempt, ...metrics };
}
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
  const routed = withoutRestatedJiraRouting(fields, {
    project: args.projectId,
    issuetype: args.issueTypeId,
  });
  return routed.ok ? routed : routingOverride(routed.fieldId);
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
  const twin = await draftTwin(request, { projectId, issueTypeId, fields, links }, metadata.fields);
  if (twin.kind === "repeat") return twin.attempt;
  const prepared = createdFields(fields, metadata.fields, trace, twin);
  if (!prepared.ok) return validationFailure(prepared);
  return createWithMetadata(
    request,
    { projectId, issueTypeId, fields: prepared.fields, links, ...descriptionMetric(prepared) },
    metadata.fields,
    policy,
  );
}
/** The fields a create sends: traced to its requirements, and with its draft identity. */
function createdFields(
  fields: Readonly<Record<string, unknown>>,
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest | undefined,
  twin: Extract<DraftTwin, { kind: "new" }>,
): JiraFieldValidationResult {
  const prepared = prepareJiraDescriptionFields(fields, metadata);
  if (!prepared.ok) return prepared;
  const traced =
    trace === undefined ? prepared.fields : traceCreateFields(prepared.fields, metadata, trace);
  return {
    ...prepared,
    fields:
      twin.identity === undefined ? traced : withJiraDraftIdentity(traced, metadata, twin.identity),
  };
}
function descriptionMetric(
  prepared: Pick<CreateRequest, "descriptionConvertedHeadingCount" | "descriptionProjection">,
): Pick<CreateRequest, "descriptionConvertedHeadingCount" | "descriptionProjection"> {
  return {
    ...(prepared.descriptionConvertedHeadingCount === undefined
      ? {}
      : { descriptionConvertedHeadingCount: prepared.descriptionConvertedHeadingCount }),
    ...(prepared.descriptionProjection === undefined
      ? {}
      : { descriptionProjection: prepared.descriptionProjection }),
  };
}
const ISSUE_KEY_VALUE = /^[A-Z][A-Z0-9_]{0,63}-\d{1,12}$/u;
/**
 * A field value that points at another issue: a bare key, or `{ key }` as `parent` takes it. A
 * string field holds text however much it reads like a key, such as a requirement id.
 */
function pointsAtIssue(value: unknown, field: JiraFieldMetadata | undefined): boolean {
  if (field?.kind === "text" || field?.schemaType === "string") return false;
  if (typeof value === "string") return ISSUE_KEY_VALUE.test(value);
  const key = asRecord(value)?.key;
  return typeof key === "string" && ISSUE_KEY_VALUE.test(key);
}
const TWIN_REF = "create";
function existingTwinRefusal(
  receipt: JiraMutationReceipt & { readonly issueKey: string },
): Extract<JiraMutationAttempt, { ok: false }> {
  const { issueKey } = receipt;
  return {
    ok: false,
    reason: "conflict",
    receipt,
    detail: {
      unchanged: true,
      messages: [
        `${issueKey} already exists as this issue: a Keiko draft created it in this project with this type and summary. Nothing was created. Report ${issueKey} as the result; do not create it again.`,
      ],
    },
  };
}
function ambiguousTwinRefusal(): Extract<JiraMutationAttempt, { ok: false }> {
  return {
    ok: false,
    reason: "conflict",
    detail: {
      messages: [
        "Several issues already match this issue: a Keiko draft created it more than once in this project with this type and summary. Nothing was created. Look them up in Jira instead of creating it again.",
      ],
    },
  };
}
/** The one-item draft a create that hangs from nothing would be, on a create screen with labels. */
function twinItem(
  create: CreateRequest,
  metadata: readonly JiraFieldMetadata[],
): JiraDraftItem | undefined {
  const hangsFromIssue = Object.entries(create.fields).some(([id, value]) =>
    pointsAtIssue(
      value,
      metadata.find((field) => field.id === id),
    ),
  );
  if (create.links.length > 0 || hangsFromIssue) return undefined;
  if (!metadata.some((field) => field.id === "labels" && field.operations.includes("set")))
    return undefined;
  return parseJiraDraft({
    items: [
      {
        ref: TWIN_REF,
        projectId: create.projectId,
        issueTypeId: create.issueTypeId,
        fields: create.fields,
      },
    ],
  })?.items[0];
}
type DraftTwin =
  | { readonly kind: "repeat"; readonly attempt: Extract<JiraMutationAttempt, { ok: false }> }
  | { readonly kind: "new"; readonly identity: string | undefined };
const UNIDENTIFIED: DraftTwin = { kind: "new", identity: undefined };
/**
 * Whether a Keiko draft already created exactly this create, found by the draft identity a draft
 * item with the same project, type and summary carries (S19 of epic #4173: the draft recognised
 * both epics as existing and said not to create them again, then Gemma created both with
 * jira.create). A match refuses the create and names the existing key; nothing is sent. Otherwise
 * the create carries that same identity, so a later draft of the item recognises the issue instead
 * of creating it a second time (S19, Qwen: jira.create first, then a draft of the same epic). Only a
 * create that hangs from nothing can be such a twin: one with links, or with a field that points at
 * another issue (a parent or epic link), never is, and neither is a create on a screen without
 * labels, where no identity label exists. Several matches refuse it too; a search that cannot be
 * completed leaves the create unmarked.
 */
async function draftTwin(
  request: JiraMutationRequest,
  create: CreateRequest,
  metadata: readonly JiraFieldMetadata[],
): Promise<DraftTwin> {
  const item = twinItem(create, metadata);
  if (item === undefined) return UNIDENTIFIED;
  const found = await reconcileJiraDraftItem(request, item, metadata, undefined);
  if (found.kind === "absent") return { kind: "new", identity: item.identity };
  if (found.kind === "refused" && !found.attempt.ok && found.attempt.reason === "conflict")
    return { kind: "repeat", attempt: ambiguousTwinRefusal() };
  const receipt = found.kind === "existing" && found.attempt.ok ? found.attempt.receipt : undefined;
  const issueKey = receipt?.issueKey;
  return issueKey === undefined
    ? UNIDENTIFIED
    : { kind: "repeat", attempt: existingTwinRefusal({ ...receipt, issueKey }) };
}
interface CreateRequest {
  readonly projectId: string;
  readonly issueTypeId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly links: readonly JiraIssueLinkRequest[];
  readonly descriptionConvertedHeadingCount?: number;
  readonly descriptionProjection?: "supported-markdown";
}
async function createWithMetadata(
  request: JiraMutationRequest,
  create: CreateRequest,
  metadata: readonly JiraFieldMetadata[],
  policy: MutationPolicy,
  onAcknowledged?: (issueKey: string) => void,
): Promise<JiraMutationAttempt> {
  const validated = validateJiraFieldChanges(
    createContextFields(metadata),
    { ...create.fields, project: { id: create.projectId }, issuetype: { id: create.issueTypeId } },
    "create",
    "data-center",
  );
  if (!validated.ok) return validationFailure(validated);
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
  // The link a template requires rides on the create itself where the screen offers it.
  const links = gate.links ?? create.links;
  const plan = planJiraIssueLinks(links, undefined, jiraIssueLinksOffered(metadata) === undefined);
  const response = await request("issue", "POST", {
    fields: validated.fields,
    update: linkedUpdate(validated, plan),
  });
  const attempt = response.ok
    ? await confirmCreatedIssue(
        request,
        response,
        metadata,
        withLinks(validated, links),
        plan,
        onAcknowledged,
      )
    : dispatchFailure(response, metadata);
  return withDescriptionFormatting(attempt, {
    ...descriptionMetric(validated),
    ...descriptionMetric(create),
  });
}
function confirmCreatedIssue(
  request: JiraMutationRequest,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  metadata: readonly JiraFieldMetadata[],
  values: JiraValidatedMutationFields,
  plan: JiraIssueLinkPlan,
  onAcknowledged?: (issueKey: string) => void,
): Promise<JiraMutationAttempt> {
  const { key, id } = response.body ?? {};
  if (response.status !== 201 || !isSafeAtlassianIdentifier(key) || !numericId(id))
    return Promise.resolve(MALFORMED);
  onAcknowledged?.(key);
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
  return { ok: true, validated, links: parseJiraIssueLinks(args.links) ?? [] };
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
/** Only links that take their own call change nothing on the issue request: none is sent. */
function changesOnlyThroughLinkCalls(
  purpose: "edit" | "transition",
  validated: Validated,
  update: Readonly<Record<string, unknown>>,
  links: readonly JiraIssueLinkRequest[],
): boolean {
  return (
    purpose === "edit" &&
    links.length > 0 &&
    Object.keys(validated.fields).length === 0 &&
    Object.keys(update).length === 0
  );
}
interface IssueReading {
  readonly values: JiraValidatedMutationFields;
  readonly transitionId: string | undefined;
}
/** The issue before the write, or a refusal when an edit would change nothing on it. */
async function readChangingIssue(
  request: JiraMutationRequest,
  metadata: readonly JiraFieldMetadata[],
  { values, transitionId }: IssueReading,
  { purpose, issueKey }: FieldTarget,
): Promise<JiraIssueReadback> {
  const prior = await readJiraMutationIssue(
    request,
    issueKey,
    jiraMutationFieldSelection(values, transitionId !== undefined),
  );
  if (!prior.ok || purpose !== "edit") return prior;
  return jiraEditAlreadyHeld(metadata, values, prior.fields)
    ? jiraAlreadyHeldRefusal(issueKey)
    : prior;
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
  const reading = { values, transitionId };
  const prior = await readChangingIssue(request, metadata.fields, reading, fieldTarget);
  if (!prior.ok) return prior;
  // Jira does not de-duplicate links: one already on the issue is not written again.
  const plan = planJiraIssueLinks(
    admitted.links,
    prior.fields.issuelinks,
    jiraIssueLinksOffered(metadata.fields) === undefined,
  );
  const update = linkedUpdate(validated, plan);
  const onlyLinkCalls = changesOnlyThroughLinkCalls(purpose, validated, update, admitted.links);
  const formatting = { ...descriptionMetric(policy), ...descriptionMetric(validated) };
  if (!onlyLinkCalls) {
    const body = { fields: validated.fields, update, ...target.body };
    const sent = await statusMutation(request, target.path, target.method, body, metadata.fields);
    if (!sent.ok) return withDescriptionFormatting(sent, formatting);
  }
  const attempt = await completeJiraLinkedMutation(
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
    onlyLinkCalls,
  );
  return withDescriptionFormatting(attempt, formatting);
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
  const prepared = prepareJiraDescriptionFields(
    fieldsInput(args.fields ?? {}) ?? {},
    metadata.fields,
  );
  if (!prepared.ok) return validationFailure(prepared);
  const traced = await traceEditArguments(
    request,
    issueKey,
    { ...args, fields: prepared.fields as CatalogJsonObject },
    metadata.fields,
    trace,
  );
  if (!traced.ok) return traced.attempt;
  return fieldMutation(request, metadata, traced.args, target, {
    ...policy,
    ...descriptionMetric(prepared),
  });
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
  if (jiraAssignmentAlreadyHeld(prior, name)) return jiraAlreadyHeldRefusal(issueKey);
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
  const prepared = draftItemCreateFields(item, fields, metadata.fields, trace);
  if (!prepared.ok) return validationFailure(prepared);
  return createWithMetadata(
    request,
    {
      projectId: item.projectId,
      issueTypeId: item.issueTypeId,
      fields: prepared.fields,
      links,
      ...descriptionMetric(prepared),
    },
    metadata.fields,
    { templates: connection.issueTemplates, check: false },
    connection.onCreatedIssueAcknowledged,
  );
}
/** The fields a draft item's create sends: with its draft identity, and traced when it is. */
function draftItemCreateFields(
  item: JiraDraftItem,
  fields: Readonly<Record<string, unknown>>,
  metadata: readonly JiraFieldMetadata[],
  trace: JiraTraceRequest | undefined,
): JiraFieldValidationResult {
  const prepared = prepareJiraDescriptionFields(fields, metadata);
  if (!prepared.ok) return prepared;
  const identified = withJiraDraftIdentity(prepared.fields, metadata, jiraDraftIdentity(item));
  return {
    ...prepared,
    fields: trace === undefined ? identified : traceCreateFields(identified, metadata, trace),
  };
}

/** One draft item the field validation of its create refuses, in that validation's own words. */
export interface JiraDraftFieldRefusal {
  readonly ref: string;
  readonly detail: JiraMutationFailureDetail;
}
export interface JiraDraftFieldRefusals {
  readonly refusals: readonly JiraDraftFieldRefusal[];
  /** The items refused, and those found invalid beyond the bound that were not looked up. */
  readonly total: number;
}
/** How many refused items one result names: the correction of those usually repairs the others. */
const DRAFT_FIELD_REFUSALS_MAX = 25;
/** A requirement reference adds a trace to the create; only that it adds one matters here. */
const STAND_IN_TRACE: JiraTraceRequest = {
  labels: [],
  footer: "-",
  footerStart: "-",
  footerEnd: "-",
  replaceLabelPrefixes: [],
};
function draftItemFieldFailure(
  item: JiraDraftItem,
  metadata: readonly JiraFieldMetadata[],
): JiraMutationFailureDetail | undefined {
  const keys = new Map(jiraDraftDependencies(item).map((ref) => [ref, JIRA_DRAFT_STAND_IN_KEY]));
  const trace = item.requirementIds === undefined ? undefined : STAND_IN_TRACE;
  const input = draftItemInput(item, keys, trace);
  if (!input.ok) return undefined;
  const prepared = draftItemCreateFields(item, input.fields, metadata, trace);
  if (!prepared.ok) return validationFailure(prepared).detail;
  const validated = validateJiraFieldChanges(
    createContextFields(metadata),
    {
      ...prepared.fields,
      project: { id: item.projectId },
      issuetype: { id: item.issueTypeId },
    },
    "create",
    "data-center",
  );
  return validated.ok ? undefined : validationFailure(validated).detail;
}
const draftTypeKey = (item: JiraDraftItem): string => `${item.projectId}/${item.issueTypeId}`;
/** The create fields of each issue type a draft uses, so its size costs no further read. */
async function draftItemMetadata(
  request: JiraMutationRequest,
  items: readonly JiraDraftItem[],
): Promise<ReadonlyMap<string, readonly JiraFieldMetadata[]>> {
  const types = [...new Map(items.map((item) => [draftTypeKey(item), item])).values()];
  const read = await Promise.all(
    types.map((item) => jiraCreateMutationMetadata(request, item.projectId, item.issueTypeId)),
  );
  return new Map(
    types.flatMap((item, index) => {
      const metadata = read[index];
      return metadata?.ok === true ? [[draftTypeKey(item), metadata.fields] as const] : [];
    }),
  );
}
interface DraftFieldCandidate extends JiraDraftFieldRefusal {
  readonly item: JiraDraftItem;
  readonly metadata: readonly JiraFieldMetadata[];
}
/** A run only reconciles an item that exists, so only an absent one can fail its validation. */
async function absentDraftItems(
  request: JiraMutationRequest,
  candidates: readonly DraftFieldCandidate[],
  index = 0,
  absent: readonly JiraDraftFieldRefusal[] = [],
): Promise<JiraDraftFieldRefusals> {
  const candidate = candidates[index];
  if (candidate === undefined || absent.length === DRAFT_FIELD_REFUSALS_MAX)
    return { refusals: absent, total: absent.length + candidates.length - index };
  const found = await reconcileJiraDraftItem(
    request,
    candidate.item,
    candidate.metadata,
    jiraDraftParentKey(candidate.item, new Map()),
  );
  const { ref, detail } = candidate;
  return absentDraftItems(
    request,
    candidates,
    index + 1,
    found.kind === "absent" ? [...absent, { ref, detail }] : absent,
  );
}
/**
 * The items a draft's run would refuse by its own field validation, read-only (S05 of #4173), so a
 * human is never asked to approve them. A read that fails decides nothing: the run still validates.
 */
export async function jiraDraftFieldRefusals(
  items: readonly JiraDraftItem[],
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  options: { readonly reconcile: boolean },
): Promise<JiraDraftFieldRefusals> {
  if (connection.deployment !== "data-center") return { refusals: [], total: 0 };
  const request = requestFor(connection, context);
  const metadata = await draftItemMetadata(request, items);
  const candidates = items.flatMap((item): readonly DraftFieldCandidate[] => {
    const fields = metadata.get(draftTypeKey(item));
    const detail = fields === undefined ? undefined : draftItemFieldFailure(item, fields);
    return fields === undefined || detail === undefined
      ? []
      : [{ ref: item.ref, detail, item, metadata: fields }];
  });
  if (!options.reconcile)
    return {
      refusals: candidates
        .slice(0, DRAFT_FIELD_REFUSALS_MAX)
        .map(({ ref, detail }) => ({ ref, detail })),
      total: candidates.length,
    };
  return absentDraftItems(request, candidates);
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

function deletionMutation(
  operation: JiraMutationOperation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  connection: JiraManagedConnection,
  check: boolean,
): Promise<JiraMutationAttempt> | undefined {
  if (isJiraCommentDelete(operation))
    return executeJiraCommentDelete(operation, args, request, check, connection.baseUrl);
  if (isJiraAttachmentMutation(operation))
    return executeJiraAttachmentMutation(operation, args, request, check);
  if (isJiraWorklogDelete(operation))
    return executeJiraWorklogDelete(operation, args, request, check, connection.issueTemplates);
  return undefined;
}

function dedicatedMutation(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
  check: boolean,
): Promise<JiraMutationAttempt> | undefined {
  const args = structuredClone(source);
  const request = requestFor(connection, context);
  if (isJiraEntityPropertyMutation(operation))
    return executeJiraEntityPropertyMutation(operation, args, {
      platform: request,
      agile: jiraAgileRequest(connection, context),
      baseUrl: connection.baseUrl,
    }, check);
  if (isJiraMonitoringMutation(operation))
    return executeJiraMonitoringMutation(operation, args, request, check);
  if (isJiraScreenTabMutation(operation))
    return executeJiraScreenTabMutation(operation, args, request, check);
  const deletion = deletionMutation(operation, args, request, connection, check);
  if (deletion !== undefined) return deletion;
  if (isJiraParticipationMutation(operation))
    return executeJiraParticipationMutation(operation, args, request, check, connection.baseUrl);
  if (isJiraWorklogMutation(operation))
    return executeJiraWorklogMutation(operation, args, request, check, connection.issueTemplates);
  if (isJiraCommentMutation(operation))
    return executeJiraCommentMutation(operation, args, request, check, connection.baseUrl);
  if (isJiraComponentMutation(operation))
    return executeJiraComponentMutation(operation, args, request, check);
  if (isJiraVersionMutation(operation))
    return executeJiraVersionMutation(operation, args, request, check);
  if (isJiraProjectMutation(operation))
    return executeJiraProjectMutation(operation, args, request, check);
  return undefined;
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
  if (isJiraAgileMutation(operation))
    return executeJiraAgileMutation(operation, structuredClone(source), context, connection);
  const dedicated = dedicatedMutation(operation, source, context, connection, false);
  if (dedicated !== undefined) return dedicated;
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
 * It reads and validates only; it never issues a POST, PUT or DELETE.
 */
/** Checks native prerequisites without writing; comment updates preserve observed visibility. */
function checkedAttempt(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraMutationAttempt> {
  if (isJiraAgileMutation(operation))
    return checkJiraAgileMutation(operation, structuredClone(source), context, connection);
  if (connection.deployment !== "data-center") return Promise.resolve({ ok: true, receipt: {} });
  const dedicated = dedicatedMutation(operation, source, context, connection, true);
  if (dedicated !== undefined) return dedicated;
  // The check mode must never reach any write.
  if (!TEMPLATE_CHECKED.has(operation)) return Promise.resolve({ ok: true, receipt: {} });
  return dispatchMutation(operation, structuredClone(source), requestFor(connection, context), {
    templates: connection.issueTemplates,
    check: true,
  });
}
export async function checkJiraManagedMutationTemplates(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraTemplateGateResult> {
  const attempt = await checkedAttempt(operation, source, context, connection);
  if (attempt.ok || attempt.violations === undefined) return { ok: true };
  return { ok: false, reason: attempt.reason, violations: attempt.violations };
}
export type JiraMutationCheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly violations?: readonly JiraTemplateViolation[];
      readonly detail?: JiraMutationFailureDetail;
    };

function requiresSuccessfulPreflight(operation: JiraMutationOperation): boolean {
  return (
    isJiraEntityPropertyMutation(operation) ||
    isJiraScreenTabMutation(operation) ||
    isJiraMonitoringMutation(operation) ||
    isJiraAgileMutation(operation) ||
    isJiraCommentMutation(operation) ||
    isJiraCommentDelete(operation) ||
    isJiraAttachmentMutation(operation) ||
    isJiraWorklogDelete(operation)
  );
}
/**
 * What a human would otherwise approve in vain: the templates, and Keiko's own validation of the
 * proposed fields (S05 of #4173), which decides the same way when the write runs. Every other
 * failure is left to the executor.
 */
export async function checkJiraManagedMutation(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraMutationCheckResult> {
  const attempt = await checkedAttempt(operation, source, context, connection);
  if (attempt.ok) return { ok: true };
  if (attempt.violations !== undefined)
    return { ok: false, reason: attempt.reason, violations: attempt.violations };
  // Dedicated admission already resolved its concrete prerequisites and reviewed state using GETs.
  // A known refusal must not be turned into an approval for a write that cannot proceed.
  if (requiresSuccessfulPreflight(operation))
    return {
      ok: false,
      reason: attempt.reason,
      ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
    };
  return attempt.reason === "field-validation" && attempt.detail?.validation !== undefined
    ? { ok: false, reason: attempt.reason, detail: attempt.detail }
    : { ok: true };
}
