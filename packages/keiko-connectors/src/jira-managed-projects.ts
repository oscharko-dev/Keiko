import {
  jiraProjectReview,
  jiraProjectReviewFields,
  type JiraProjectReview,
} from "./jira-project-review.js";
import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
  sanitizeJiraMutationFailureDetail,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import { dispatchFailure, type JiraHttpFailure } from "./jira-mutation-failure.js";
import {
  jiraNativeId as projectId,
  jiraNativeName,
  jiraNativeText as boundedText,
  JIRA_PROJECT_LEAD_MAX_CHARS,
  JIRA_PROJECT_URL_MAX_CHARS,
} from "./jira-native-values.js";
import { jiraReadbackValueMatches } from "./jira-readback-values.js";

type ProjectRead = (typeof JIRA_READ_TOOL_FAMILIES.projects)[number];
type ProjectWrite = "jira.create-project" | "jira.update-project";
type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
interface ProjectView {
  /** Private readback evidence; never spread into a tool result or receipt. */
  readonly invalidMetadataFields: ReadonlySet<string>;
  readonly reviewSnapshot?: JiraProjectReview;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly description?: string;
  readonly url?: string;
  readonly lead?: string;
  readonly assigneeType?: string;
  readonly projectTypeKey?: string;
}
type ProjectReceipt = Required<Pick<JiraMutationReceipt, "projectId" | "projectKey">> &
  Pick<JiraMutationReceipt, "projectName">;
type ProjectReadback = Failure | { readonly ok: true; readonly project: ProjectView };
type KeyValidation =
  | Failure
  | { readonly ok: true; readonly valid: boolean; readonly detail?: JiraMutationFailureDetail };
const READS: ReadonlySet<string> = new Set(JIRA_READ_TOOL_FAMILIES.projects);
const PROJECT_FIELDS = new Set(["name", "lead", "description", "url", "assigneeType"]);
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const INVALID: Failure = {
  ok: false,
  reason: "field-validation",
  detail: {
    validation: "invalid-field",
    messages: [
      "Use only the typed project arguments. Create requires key, name, lead and projectTypeKey; update requires at least one supported metadata change. Names must contain 1–255 characters without surrounding whitespace.",
    ],
  },
};
function projectUrl(value: unknown): value is string {
  if (!boundedText(value, JIRA_PROJECT_URL_MAX_CHARS, true)) return false;
  if (value === "") return true;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === ""
  );
}
function validField(key: string, value: unknown): boolean {
  switch (key) {
    case "name":
      return jiraNativeName(value, 255);
    case "lead":
      return boundedText(value, JIRA_PROJECT_LEAD_MAX_CHARS);
    case "description":
      return boundedText(value, 32768, true);
    case "url":
      return projectUrl(value);
    case "assigneeType":
      return value === "PROJECT_LEAD" || value === "UNASSIGNED";
    case "projectTypeKey":
      return isSafeAtlassianIdentifier(value);
    case "projectTemplateKey":
      return boundedText(value, 255);
    default:
      return false;
  }
}
function projectMetadata(body: Record<string, unknown>): {
  readonly optional: Record<string, string>;
  readonly invalidMetadataFields: ReadonlySet<string>;
} {
  const optional: Record<string, string> = {};
  const invalidMetadataFields = new Set<string>();
  for (const field of ["description", "url", "lead", "assigneeType", "projectTypeKey"]) {
    if (body[field] === undefined) continue;
    if ((field === "description" || field === "url") && body[field] === null) continue;
    const value = field === "lead" ? asRecord(body.lead)?.name : body[field];
    if (typeof value !== "string" || !validField(field, value)) invalidMetadataFields.add(field);
    else optional[field] = value;
  }
  return { optional, invalidMetadataFields };
}
function projectView(body: Record<string, unknown> | undefined): ProjectView | undefined {
  if (
    body === undefined ||
    !projectId(body.id) ||
    !isSafeAtlassianIdentifier(body.key) ||
    !boundedText(body.name, 255)
  )
    return undefined;
  const { optional, invalidMetadataFields } = projectMetadata(body);
  const reviewSnapshot = jiraProjectReview(body);
  return {
    projectId: body.id,
    projectKey: body.key,
    projectName: body.name,
    ...optional,
    invalidMetadataFields,
    ...(reviewSnapshot === undefined ? {} : { reviewSnapshot }),
  };
}
function receipt(project: ProjectView): ProjectReceipt {
  return {
    projectId: project.projectId,
    projectKey: project.projectKey,
    projectName: project.projectName,
  };
}
export async function readJiraBoundProject(
  request: JiraMutationRequest,
  target: string,
): Promise<ProjectReadback> {
  const result = await request(`project/${encodeURIComponent(target)}`);
  if (!result.ok) return dispatchFailure(result);
  const project = result.status === 200 ? projectView(result.body) : undefined;
  if (project === undefined) return MALFORMED;
  if (project.projectId !== target && project.projectKey.toUpperCase() !== target.toUpperCase())
    return { ok: false, reason: "conflict" };
  return { ok: true, project };
}
function keyErrors(body: Record<string, unknown>): JiraMutationFailureDetail | undefined {
  const errors = asRecord(body.errors ?? {});
  const messages: unknown = body.errorMessages ?? [];
  if (
    errors === undefined ||
    !Array.isArray(messages) ||
    Object.keys(errors).length > 8 ||
    messages.length > 3
  )
    return undefined;
  const fieldErrors = Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }));
  if (
    !fieldErrors.every(
      ({ fieldId, message }) => isSafeAtlassianIdentifier(fieldId) && boundedText(message, 2048),
    ) ||
    !messages.every((message: unknown) => boundedText(message, 2048))
  )
    return undefined;
  if (fieldErrors.length + messages.length === 0) return {};
  return sanitizeJiraMutationFailureDetail({ fieldErrors, messages });
}
async function validateKey(request: JiraMutationRequest, key: string): Promise<KeyValidation> {
  const result = await request(`projectvalidate/key?${new URLSearchParams({ key }).toString()}`);
  if (!result.ok) return dispatchFailure(result);
  if (result.status !== 200 || result.body === undefined) return MALFORMED;
  const detail = keyErrors(result.body);
  if (detail === undefined) return MALFORMED;
  return {
    ok: true,
    valid: (detail.fieldErrors?.length ?? 0) + (detail.messages?.length ?? 0) === 0,
    detail,
  };
}
export async function readJiraAccessibleProjectType(
  request: JiraMutationRequest,
  key: string,
): Promise<Failure | { readonly ok: true; readonly name?: string }> {
  const result = await request(`project/type/${encodeURIComponent(key)}/accessible`);
  if (!result.ok) return dispatchFailure(result);
  if (result.status !== 200 || result.body?.key !== key) return MALFORMED;
  const name = result.body.formattedKey;
  if (name !== undefined && !boundedText(name, 255)) return MALFORMED;
  return { ok: true, ...(name === undefined ? {} : { name }) };
}
function permissionEntry(key: string, value: unknown): CatalogJsonObject | undefined {
  const permission = asRecord(value);
  if (!isSafeAtlassianIdentifier(key) || typeof permission?.havePermission !== "boolean")
    return undefined;
  if (permission.key !== undefined && permission.key !== key) return undefined;
  if (permission.name !== undefined && !boundedText(permission.name, 255)) return undefined;
  return {
    key,
    havePermission: permission.havePermission,
    ...(permission.name === undefined ? {} : { name: permission.name }),
  };
}
function readArgument(
  name: ProjectRead,
  args: CatalogJsonObject,
): { readonly target: string | undefined } | undefined {
  let key: "key" | "projectTypeKey" | "projectIdOrKey";
  if (name === "jira.project-type") {
    key = "projectTypeKey";
  } else if (name === "jira.validate-project-key") {
    key = "key";
  } else {
    key = "projectIdOrKey";
  }

  if (!Object.keys(args).every((field) => field === key)) return undefined;
  const target = args[key];
  if (name === "jira.project-permissions" && target === undefined) return { target };
  return isSafeAtlassianIdentifier(target) ? { target } : undefined;
}
export function isJiraProjectRead(name: string): name is ProjectRead {
  return READS.has(name);
}
export function isJiraProjectMutation(name: string): name is ProjectWrite {
  return name === "jira.create-project" || name === "jira.update-project";
}

async function projectResult(
  request: JiraMutationRequest,
  target: string,
): Promise<ManagedMcpToolResult> {
  const result = await readJiraBoundProject(request, target);
  if (!result.ok) return jiraReadFailure(result.reason, result.detail);
  const { invalidMetadataFields, reviewSnapshot, ...project } = result.project;
  return {
    data: {
      outcome: "succeeded",
      ...project,
      ...jiraProjectReviewFields(reviewSnapshot),
      ...(invalidMetadataFields.size === 0
        ? {}
        : { omittedMetadataCount: invalidMetadataFields.size }),
    },
  };
}
async function keyResult(request: JiraMutationRequest, key: string): Promise<ManagedMcpToolResult> {
  const result = await validateKey(request, key);
  if (!result.ok) return jiraReadFailure(result.reason, result.detail);
  const { fieldErrors, messages } = result.detail ?? {};
  return {
    data: {
      outcome: "succeeded",
      key,
      valid: result.valid,
      ...(fieldErrors === undefined
        ? {}
        : { fieldErrors: fieldErrors.map((error) => ({ ...error })) }),
      ...(messages === undefined ? {} : { messages: [...messages] }),
    },
  };
}
async function typeResult(
  request: JiraMutationRequest,
  key: string,
): Promise<ManagedMcpToolResult> {
  const result = await readJiraAccessibleProjectType(request, key);
  if (result.ok) {
    return {
      data: {
        outcome: "succeeded",
        projectTypeKey: key,
        ...(result.name === undefined ? {} : { name: result.name }),
      },
    };
  }
  return jiraReadFailure(result.reason, result.detail);
}
async function permissionResult(
  request: JiraMutationRequest,
  target: string | undefined,
): Promise<ManagedMcpToolResult> {
  let query: string;
  if (target === undefined) {
    query = "";
  } else {
    query = `?${new URLSearchParams({ [projectId(target) ? "projectId" : "projectKey"]: target }).toString()}`;
  }
  const result = await request(`mypermissions${query}`);
  if (!result.ok) return jiraReadFailure(result.reason, result.remote);
  const values = result.status === 200 ? asRecord(result.body?.permissions) : undefined;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  const entries = Object.entries(values);
  if (entries.length > 100) return jiraReadFailure("bounds-exceeded");
  const items = entries.map(([key, value]) => permissionEntry(key, value));
  return items.includes(undefined)
    ? jiraReadFailure("malformed-payload")
    : { data: { outcome: "succeeded", permissions: items.filter((item) => item !== undefined) } };
}
/** Four closed native read operations over the existing bounded request port. */
export function executeJiraProjectRead(
  name: ProjectRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = readArgument(name, args);
  if (selected === undefined) return Promise.resolve(jiraReadFailure("invalid-input"));
  const target = selected.target ?? "";
  switch (name) {
    case "jira.project":
      return projectResult(request, target);
    case "jira.validate-project-key":
      return keyResult(request, target);
    case "jira.project-type":
      return typeResult(request, target);
    case "jira.project-permissions":
      return permissionResult(request, selected.target);
  }
}
interface ProjectCreateArguments extends CatalogJsonObject {
  readonly key: string;
  readonly projectTypeKey: string;
}
function createInput(args: CatalogJsonObject): args is ProjectCreateArguments {
  const { key, name, lead, projectTypeKey } = args;
  return (
    isSafeAtlassianIdentifier(key) &&
    jiraNativeName(name, 255) &&
    boundedText(lead, 128) &&
    isSafeAtlassianIdentifier(projectTypeKey) &&
    Object.entries(args).every(
      ([field, value]) =>
        field === "key" ||
        ((PROJECT_FIELDS.has(field) ||
          field === "projectTypeKey" ||
          field === "projectTemplateKey") &&
          validField(field, value)),
    )
  );
}
function updateInput(
  args: CatalogJsonObject,
): { readonly target: string; readonly fields: Readonly<Record<string, unknown>> } | undefined {
  if (!isSafeAtlassianIdentifier(args.projectIdOrKey)) return undefined;
  const fields = Object.entries(args).filter(([key]) => key !== "projectIdOrKey");
  return fields.length > 0 &&
    fields.every(([key, value]) => PROJECT_FIELDS.has(key) && validField(key, value))
    ? { target: args.projectIdOrKey, fields: Object.fromEntries(fields) }
    : undefined;
}
function holds(project: ProjectView, fields: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(fields).every(([field, expected]) => {
    if (project.invalidMetadataFields.has(field)) return false;
    let actual: unknown;
    if (field === "key") {
      actual = project.projectKey;
    } else if (field === "name") {
      actual = project.projectName;
    } else {
      actual = Reflect.get(project, field);
    }

    let kind: "exact" | "clearable-text" | "user-name";
    if (field === "lead") {
      kind = "user-name";
    } else if (field === "description" || field === "url") {
      kind = "clearable-text";
    } else {
      kind = "exact";
    }

    return jiraReadbackValueMatches(kind, actual, expected);
  });
}
async function confirmProject(
  request: JiraMutationRequest,
  identity: ProjectReceipt,
  fields: Readonly<Record<string, unknown>>,
): Promise<JiraMutationAttempt> {
  const current = await readJiraBoundProject(request, identity.projectId);
  if (!current.ok) return { ...current, receipt: identity };
  if (current.project.projectKey !== identity.projectKey || !holds(current.project, fields))
    return { ok: false, reason: "conflict", receipt: receipt(current.project) };
  return { ok: true, receipt: receipt(current.project) };
}
async function withUnconfirmedProjectReadback(
  request: JiraMutationRequest,
  key: string,
  failure: Failure,
): Promise<JiraMutationAttempt> {
  const current = await readJiraBoundProject(request, key);
  return current.ok ? { ...failure, receipt: receipt(current.project) } : failure;
}
async function failedProjectWrite(
  request: JiraMutationRequest,
  key: string,
  response: JiraHttpFailure,
  prior?: ProjectReceipt,
): Promise<JiraMutationAttempt> {
  const failed = {
    ...dispatchFailure(response),
    ...(prior === undefined ? {} : { receipt: prior }),
  };
  return response.httpStatus === 409 ||
    response.reason === "timeout" ||
    response.reason === "unavailable" ||
    response.reason === "malformed-payload"
    ? withUnconfirmedProjectReadback(request, key, failed)
    : failed;
}
function createdIdentity(
  result: Extract<Awaited<ReturnType<JiraMutationRequest>>, { readonly ok: true }>,
  key: string,
): ProjectReceipt | undefined {
  const id = result.body?.id;
  return result.status === 201 &&
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    result.body?.key === key
    ? { projectId: String(id), projectKey: key }
    : undefined;
}
async function createProject(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  check: boolean,
): Promise<JiraMutationAttempt> {
  if (!createInput(args)) return INVALID;
  const key = args.key;
  const validation = await validateKey(request, key);
  if (!validation.ok) return validation;
  if (!validation.valid)
    return {
      ok: false,
      reason: "field-validation",
      detail: { ...validation.detail, fieldId: "key", validation: "invalid-field" },
    };
  const available = await readJiraAccessibleProjectType(request, args.projectTypeKey);
  if (!available.ok) return available;
  if (check) return { ok: true, receipt: {} };
  const result = await request("project", "POST", args);
  if (!result.ok) return failedProjectWrite(request, key, result);
  const identity = createdIdentity(result, key);
  // The native create accepts this selector; ProjectBean exposes no template identity to read back.
  // Confirm the identity and every requested readable field, without claiming template/board proof.
  const readableFields = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "projectTemplateKey"),
  );
  return identity === undefined
    ? withUnconfirmedProjectReadback(request, key, MALFORMED)
    : confirmProject(request, identity, readableFields);
}
async function updateProject(
  request: JiraMutationRequest,
  args: CatalogJsonObject,
  check: boolean,
): Promise<JiraMutationAttempt> {
  const input = updateInput(args);
  if (input === undefined) return INVALID;
  const { fields } = input;
  const prior = await readJiraBoundProject(request, input.target);
  if (!prior.ok) return prior;
  if (holds(prior.project, fields))
    return {
      ok: false,
      reason: "conflict",
      receipt: receipt(prior.project),
      detail: {
        unchanged: true,
        messages: ["The project already holds these values. Nothing was written."],
      },
    };
  if (check) return { ok: true, receipt: {} };
  const result = await request(
    `project/${encodeURIComponent(prior.project.projectId)}`,
    "PUT",
    fields,
  );
  if (!result.ok)
    return failedProjectWrite(request, prior.project.projectId, result, receipt(prior.project));
  if (result.status !== 200) return { ...MALFORMED, receipt: receipt(prior.project) };
  return confirmProject(request, receipt(prior.project), fields);
}
/** One mutation attempt; HTTP and durable no-replay ownership stay in the existing caller. */
export function executeJiraProjectMutation(
  operation: ProjectWrite,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraMutationAttempt> {
  return operation === "jira.create-project"
    ? createProject(request, args, check)
    : updateProject(request, args, check);
}
