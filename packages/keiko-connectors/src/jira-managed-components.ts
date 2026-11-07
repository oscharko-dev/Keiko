import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId as id, jiraNativeText as text } from "./jira-native-values.js";

type ComponentRead = "jira.components" | "jira.component";
type ComponentWrite = "jira.create-component" | "jira.update-component";
type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
interface ComponentReceipt extends JiraMutationReceipt {
  readonly componentId?: string;
}
type ComponentAttempt =
  | (Omit<Extract<JiraMutationAttempt, { readonly ok: true }>, "receipt"> & {
      readonly receipt: ComponentReceipt;
    })
  | (Omit<Failure, "receipt"> & { readonly receipt?: ComponentReceipt });
interface ProjectBinding {
  readonly projectId: string;
  readonly projectKey: string;
}
interface ComponentView extends CatalogJsonObject {
  readonly id: string;
  readonly name: string;
  readonly project: string;
}
type ComponentReadback = Failure | { readonly ok: true; readonly component: ComponentView };
const ASSIGNEES: ReadonlySet<string> = new Set([
  "PROJECT_DEFAULT",
  "COMPONENT_LEAD",
  "PROJECT_LEAD",
  "UNASSIGNED",
]);
const COMPONENT_BODY_MAX_BYTES = 32768;
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const INVALID: Failure = {
  ok: false,
  reason: "field-validation",
  detail: { validation: "invalid-field" },
};
function validField(key: string, value: unknown): boolean {
  switch (key) {
    case "name":
    case "leadUserName":
      return text(value, 255);
    case "description":
      return text(value, COMPONENT_BODY_MAX_BYTES, true);
    case "assigneeType":
      return typeof value === "string" && ASSIGNEES.has(value);
    default:
      return false;
  }
}
function leadFields(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const lead = asRecord(raw.lead)?.name;
  const username = raw.leadUserName === undefined ? lead : raw.leadUserName;
  if (username === undefined) return {};
  return !text(username, 255) || (lead !== undefined && lead !== username)
    ? undefined
    : { leadUserName: username };
}
function validOptionalField(key: string, value: unknown): value is string | boolean {
  return key === "archived" || key === "deleted"
    ? typeof value === "boolean"
    : validField(key, value);
}
function optionalFields(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, string | boolean> = {};
  for (const key of ["description", "assigneeType", "archived", "deleted"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!validOptionalField(key, value)) return undefined;
    result[key] = value;
  }
  const lead = leadFields(raw);
  return lead === undefined ? undefined : { ...result, ...lead };
}
function componentView(value: unknown): ComponentView | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !id(raw.id) ||
    !text(raw.name, 255) ||
    !isSafeAtlassianIdentifier(raw.project)
  )
    return undefined;
  const fields = optionalFields(raw);
  return fields === undefined
    ? undefined
    : { id: raw.id, name: raw.name, project: raw.project, ...fields };
}
async function readProject(
  request: JiraMutationRequest,
  target: string,
): Promise<Failure | { readonly ok: true; readonly project: ProjectBinding }> {
  const result = await request(`project/${encodeURIComponent(target)}`);
  if (!result.ok) return dispatchFailure(result);
  const raw = result.body;
  if (result.status !== 200 || !id(raw?.id) || !isSafeAtlassianIdentifier(raw.key))
    return MALFORMED;
  if (raw.id !== target && raw.key.toUpperCase() !== target.toUpperCase())
    return { ok: false, reason: "conflict" };
  return { ok: true, project: { projectId: raw.id, projectKey: raw.key } };
}
async function readComponent(
  request: JiraMutationRequest,
  target: string,
): Promise<ComponentReadback> {
  const result = await request(`component/${target}`);
  if (!result.ok) return dispatchFailure(result);
  const component = result.status === 200 ? componentView(result.body) : undefined;
  if (component === undefined) return MALFORMED;
  return component.id === target ? { ok: true, component } : { ok: false, reason: "conflict" };
}
function pageNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  return value === undefined
    ? fallback
    : typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : undefined;
}
function listInput(args: CatalogJsonObject):
  | {
      readonly target: string;
      readonly startAt: number;
      readonly maxResults: number;
    }
  | undefined {
  const startAt = pageNumber(args.startAt, 0, 0, 1_000_000);
  const maxResults = pageNumber(args.maxResults, 25, 1, 100);
  if (
    !isSafeAtlassianIdentifier(args.projectIdOrKey) ||
    startAt === undefined ||
    maxResults === undefined ||
    Object.keys(args).some(
      (key) => key !== "projectIdOrKey" && key !== "startAt" && key !== "maxResults",
    )
  )
    return undefined;
  return { target: args.projectIdOrKey, startAt, maxResults };
}
async function components(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const input = listInput(args);
  if (input === undefined) return jiraReadFailure("invalid-input");
  const current = await readProject(request, input.target);
  if (!current.ok) return jiraReadFailure(current.reason, current.detail);
  const result = await request(
    `project/${current.project.projectId}/components`,
    "GET",
    undefined,
    "json-array",
  );
  if (!result.ok) return jiraReadFailure(result.reason, result.remote);
  if (result.status !== 200 || result.items === undefined)
    return jiraReadFailure("malformed-payload");
  if (result.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(
    result.items,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    (value) => {
      const component = componentView(value);
      return component?.project === current.project.projectKey ? component : undefined;
    },
    "id",
  );
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult(localJiraPage(items, input.startAt, input.maxResults));
}
export function isJiraComponentRead(name: string): name is ComponentRead {
  return name === "jira.components" || name === "jira.component";
}
export function isJiraComponentMutation(name: string): name is ComponentWrite {
  return name === "jira.create-component" || name === "jira.update-component";
}
/** Native component reads share the caller's bound project/credential transport. */
export async function executeJiraComponentRead(
  operation: ComponentRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  if (operation === "jira.components") return components(args, request);
  if (!id(args.componentId) || Object.keys(args).some((key) => key !== "componentId"))
    return jiraReadFailure("invalid-input");
  const result = await readComponent(request, args.componentId);
  return result.ok
    ? boundJiraReadResult({ data: { outcome: "succeeded", items: [result.component] } })
    : jiraReadFailure(result.reason, result.detail);
}
interface MutationInput {
  readonly target: string;
  readonly fields: Readonly<Record<string, unknown>>;
}
function mutationInput(
  operation: ComponentWrite,
  args: CatalogJsonObject,
): MutationInput | undefined {
  const create = operation === "jira.create-component";
  const key = create ? "projectIdOrKey" : "componentId";
  const target = args[key];
  if (typeof target !== "string" || !(create ? isSafeAtlassianIdentifier(target) : id(target)))
    return undefined;
  const entries = Object.entries(args).filter(([name]) => name !== key);
  if (
    entries.length === 0 ||
    (create && !validField("name", args.name)) ||
    !entries.every(([name, value]) => validField(name, value))
  )
    return undefined;
  const fields = Object.fromEntries(entries);
  return new TextEncoder().encode(JSON.stringify(fields)).byteLength > COMPONENT_BODY_MAX_BYTES
    ? undefined
    : { target, fields };
}
function holds(component: ComponentView, fields: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(fields).every(([key, value]) => component[key] === value);
}
async function confirm(
  request: JiraMutationRequest,
  identity: ComponentReceipt & { readonly componentId: string; readonly projectKey: string },
  fields: Readonly<Record<string, unknown>>,
  failure?: Failure,
): Promise<ComponentAttempt> {
  const readback = await readComponent(request, identity.componentId);
  if (failure !== undefined) return { ...failure, receipt: identity };
  if (!readback.ok) return { ...readback, receipt: identity };
  return readback.component.project === identity.projectKey && holds(readback.component, fields)
    ? { ok: true, receipt: identity }
    : { ok: false, reason: "conflict", receipt: identity };
}
async function createComponent(
  input: MutationInput,
  request: JiraMutationRequest,
  check: boolean,
): Promise<ComponentAttempt> {
  const current = await readProject(request, input.target);
  if (!current.ok) return current;
  const body = { ...input.fields, project: current.project.projectKey };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > COMPONENT_BODY_MAX_BYTES)
    return { ok: false, reason: "bounds-exceeded" };
  if (check) return { ok: true, receipt: {} };
  const result = await request("component", "POST", body);
  if (!result.ok) return { ...dispatchFailure(result), receipt: current.project };
  if (result.status !== 201 || !id(result.body?.id))
    return { ...MALFORMED, receipt: current.project };
  return confirm(request, { ...current.project, componentId: result.body.id }, input.fields);
}
async function updateComponent(
  input: MutationInput,
  request: JiraMutationRequest,
  check: boolean,
): Promise<ComponentAttempt> {
  const prior = await readComponent(request, input.target);
  if (!prior.ok) return prior;
  const current = await readProject(request, prior.component.project);
  if (!current.ok) return current;
  const identity = { ...current.project, componentId: prior.component.id };
  if (holds(prior.component, input.fields))
    return { ok: false, reason: "conflict", receipt: identity };
  if (check) return { ok: true, receipt: {} };
  const result = await request(`component/${prior.component.id}`, "PUT", input.fields);
  const failure = !result.ok
    ? dispatchFailure(result)
    : result.status === 200
      ? undefined
      : MALFORMED;
  return confirm(request, identity, input.fields, failure);
}
/** One native attempt only; custody, authority, logging and durable no-replay stay with the caller. */
export function executeJiraComponentMutation(
  operation: ComponentWrite,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<ComponentAttempt> {
  const input = mutationInput(operation, args);
  if (input === undefined) return Promise.resolve(INVALID);
  return operation === "jira.create-component"
    ? createComponent(input, request, check)
    : updateComponent(input, request, check);
}
