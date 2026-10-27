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
import type { JiraManagedConnection } from "./jira-managed-connection.js";
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
  confirmJiraMutationFields,
  jiraMutationFieldSelection,
  readJiraMutationIssue,
  type JiraValidatedMutationFields,
} from "./jira-mutation-confirmation.js";

type MutationValidation = { readonly ok: true } | Extract<JiraMutationAttempt, { ok: false }>;
const INVALID = { ok: false, reason: "field-validation" } as const;
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
// eslint-disable-next-line no-control-regex -- HTTP reference values must not contain control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
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
function requestFor(
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
  return (path, method = "GET", body, expect = "json") =>
    executeAtlassianWriteRequest(
      {
        signal,
        http: (request) =>
          signal.aborted || beforeEffect() !== true
            ? Promise.resolve({ kind: "network-error" })
            : http(request),
      },
      {
        method,
        url: atlassianApiUrl(endpoints, path),
        expect,
        ...(body === undefined ? {} : { bodyJson: JSON.stringify(body) }),
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
  if (!response.ok) return response;
  return response.status === 204 ? { ok: true } : MALFORMED;
}
async function createIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
): Promise<JiraMutationAttempt> {
  const { projectId, issueTypeId } = args;
  const fields = fieldsInput(args.fields);
  if (
    !keysAllowed(args, ["projectId", "issueTypeId", "fields"]) ||
    !numericId(projectId) ||
    !numericId(issueTypeId) ||
    fields === undefined
  )
    return INVALID;
  const metadata = await jiraCreateMutationMetadata(request, projectId, issueTypeId);
  if (!metadata.ok) return metadata;
  const validated = validateJiraFieldChanges(
    metadata.fields,
    { ...fields, project: { id: projectId }, issuetype: { id: issueTypeId } },
    "create",
    "data-center",
  );
  if (!validated.ok) return INVALID;
  const response = await request("issue", "POST", {
    fields: validated.fields,
    update: validated.update,
  });
  if (!response.ok) return response;
  return confirmCreatedIssue(request, response, metadata.fields, validated);
}
function confirmCreatedIssue(
  request: JiraMutationRequest,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  metadata: readonly JiraFieldMetadata[],
  values: JiraValidatedMutationFields,
): Promise<JiraMutationAttempt> {
  const { key, id } = response.body ?? {};
  if (response.status !== 201 || !isSafeAtlassianIdentifier(key) || !numericId(id))
    return Promise.resolve(MALFORMED);
  return confirmJiraMutationFields(request, {
    issueKey: key,
    receipt: { issueKey: key, issueId: id },
    metadata,
    values,
  });
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
async function fieldMutation(
  request: JiraMutationRequest,
  metadata: JiraMutationMetadata,
  args: CatalogJsonObject,
  purpose: "edit" | "transition",
  issueKey: string,
  targetStatusId?: string,
): Promise<JiraMutationAttempt> {
  if (!metadata.ok) return metadata;
  const validated = validateJiraFieldChanges(
    metadata.fields,
    args.fields ?? {},
    purpose,
    "data-center",
    args.updates ?? [],
  );
  if (!validated.ok) return INVALID;
  const transitionId =
    purpose === "transition" && typeof args.transitionId === "string"
      ? args.transitionId
      : undefined;
  const target = fieldMutationTarget(issueKey, transitionId);
  const prior = await readJiraMutationIssue(
    request,
    issueKey,
    jiraMutationFieldSelection(validated, transitionId !== undefined),
  );
  if (!prior.ok) return prior;
  const acknowledged = await statusMutation(request, target.path, target.method, {
    fields: validated.fields,
    update: validated.update,
    ...target.body,
  });
  if (!acknowledged.ok) return acknowledged;
  return confirmJiraMutationFields(request, {
    issueKey,
    receipt: target.receipt,
    metadata: metadata.fields,
    values: validated,
    prior,
    ...(targetStatusId === undefined ? {} : { targetStatusId }),
  });
}
async function editIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
): Promise<JiraMutationAttempt> {
  const fields = fieldsInput(args.fields ?? {});
  const updates = asArray(args.updates ?? []);
  if (
    !keysAllowed(args, ["issueKey", "fields", "updates"]) ||
    fields === undefined ||
    updates === undefined ||
    (Object.keys(fields).length === 0 && updates.length === 0)
  )
    return INVALID;
  return fieldMutation(
    request,
    await jiraEditMutationMetadata(request, issueKey),
    args,
    "edit",
    issueKey,
  );
}
async function transitionIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
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
  return fieldMutation(request, metadata, args, "transition", issueKey, metadata.targetStatusId);
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

async function assignIssue(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  issueKey: string,
): Promise<JiraMutationAttempt> {
  const name = args.assigneeName;
  if (!keysAllowed(args, ["issueKey", "assigneeName"]) || (name !== null && !userName(name)))
    return INVALID;
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
  if (!response.ok) return response;
  const id = response.body?.id;
  return response.status === 201 && numericId(id)
    ? confirmJiraComment(request, issueKey, id, body)
    : MALFORMED;
}

/** Fresh capability metadata and one mutation request. Durability/authority remain server-owned. */
export function executeJiraManagedMutation(
  operation: JiraMutationOperation,
  source: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<JiraMutationAttempt> {
  if (connection.deployment !== "data-center")
    return Promise.resolve({ ok: false, reason: "unavailable" });
  const args = structuredClone(source);
  const request = requestFor(connection, context);
  if (operation === "jira.create") return createIssue(request, args);
  const issueKey = args.issueKey;
  if (!isSafeAtlassianIdentifier(issueKey)) return Promise.resolve(INVALID);
  switch (operation) {
    case "jira.edit":
      return editIssue(request, args, issueKey);
    case "jira.assign":
      return assignIssue(request, args, issueKey);
    case "jira.comment":
      return addComment(request, args, issueKey);
    case "jira.transition":
      return transitionIssue(request, args, issueKey);
    default:
      return Promise.resolve(INVALID);
  }
}
