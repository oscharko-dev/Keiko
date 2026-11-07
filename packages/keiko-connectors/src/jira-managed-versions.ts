import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { dispatchFailure } from "./jira-mutation-failure.js";

type VersionRead = "jira.versions" | "jira.version";
type VersionWrite = "jira.create-version" | "jira.update-version";
type VersionReceipt = JiraMutationReceipt & { readonly versionId?: string };
type Failure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & {
  readonly receipt?: VersionReceipt;
};
/** Private until the composing owner admits the native version operations into the catalog. */
export type JiraVersionMutationAttempt =
  Failure | { readonly ok: true; readonly receipt: VersionReceipt };
interface VersionView extends CatalogJsonObject {
  readonly versionId: string;
  readonly projectId: string;
  readonly name: string;
}
type VersionReadback = Failure | { readonly ok: true; readonly version: VersionView };
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const INVALID: Failure = {
  ok: false,
  reason: "field-validation",
  detail: {
    validation: "invalid-field",
    messages: [
      "Create requires projectId and name. Update requires versionId and a supported metadata change. Use ISO calendar dates and explicit boolean release or archive states.",
    ],
  },
};
const VERSION_FIELDS = [
  "name",
  "description",
  "startDate",
  "releaseDate",
  "released",
  "archived",
] as const;
const LIST_MAX = 1000;

/** VersionBean.id is a decimal string; preserve it without a floating-point conversion. */
function versionId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) return false;
  return BigInt(value) < 9223372036854775808n;
}
/** VersionBean.projectId is an int64 JSON number; never round a caller's identifier. */
function projectNumber(value: unknown): number | undefined {
  if (!versionId(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validField(field: string, value: unknown): boolean {
  if (field === "released" || field === "archived") return typeof value === "boolean";
  // Native Data Center examples use calendar dates despite the Swagger date-time annotation.
  if (field === "startDate" || field === "releaseDate") return calendarDate(value);
  if (field !== "name" && field !== "description") return false;
  return validText(value, field === "description");
}
function validText(value: unknown, description: boolean): value is string {
  return (
    typeof value === "string" &&
    value.length <= (description ? 32768 : 255) &&
    (description || value.trim().length > 0) &&
    // eslint-disable-next-line no-control-regex -- metadata permits ordinary tabs and line breaks.
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  );
}
function versionMetadata(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const values: Record<string, string | boolean> = {};
  for (const field of VERSION_FIELDS) {
    const selected = raw[field];
    if (selected === undefined) continue;
    if (selected === null && (field === "startDate" || field === "releaseDate")) continue;
    if (!validField(field, selected)) return undefined;
    values[field] = selected as string | boolean;
  }
  return values;
}
function versionView(value: unknown): VersionView | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !versionId(raw.id) ||
    typeof raw.projectId !== "number" ||
    !Number.isSafeInteger(raw.projectId) ||
    raw.projectId <= 0 ||
    !validText(raw.name, false)
  )
    return undefined;
  const metadata = versionMetadata(raw);
  return metadata === undefined
    ? undefined
    : { ...metadata, versionId: raw.id, projectId: String(raw.projectId), name: raw.name };
}
async function readVersion(request: JiraMutationRequest, id: string): Promise<VersionReadback> {
  const result = await request(`version/${id}`);
  if (!result.ok) return dispatchFailure(result);
  const version = result.status === 200 ? versionView(result.body) : undefined;
  if (version === undefined) return MALFORMED;
  return version.versionId === id ? { ok: true, version } : { ok: false, reason: "conflict" };
}
async function readProjectId(
  request: JiraMutationRequest,
  target: string,
): Promise<Failure | { readonly ok: true; readonly projectId: string }> {
  const result = await request(`project/${encodeURIComponent(target)}`);
  if (!result.ok) return dispatchFailure(result);
  const id = result.body?.id;
  if (result.status !== 200 || !versionId(id) || projectNumber(id) === undefined) return MALFORMED;
  const matchesTarget = /^[0-9]+$/u.test(target)
    ? id === target
    : typeof result.body?.key === "string" &&
      result.body.key.toUpperCase() === target.toUpperCase();
  if (!matchesTarget) return { ok: false, reason: "conflict" };
  return { ok: true, projectId: id };
}
function asRead(result: VersionReadback): ManagedMcpToolResult {
  return result.ok
    ? { data: { outcome: "succeeded", ...result.version } }
    : jiraReadFailure(result.reason, result.detail);
}
async function listVersions(
  request: JiraMutationRequest,
  target: string,
  startAt: number,
  maxResults: number,
): Promise<ManagedMcpToolResult> {
  const project = await readProjectId(request, target);
  if (!project.ok) return jiraReadFailure(project.reason, project.detail);
  const response = await request(
    `project/${project.projectId}/versions`,
    "GET",
    undefined,
    "json-array",
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200 || response.items === undefined)
    return jiraReadFailure("malformed-payload");
  if (response.items.length > LIST_MAX) return jiraReadFailure("bounds-exceeded");
  const versions = response.items.map(versionView);
  const identities = new Set<string>();
  for (const item of versions) {
    if (item === undefined) return jiraReadFailure("malformed-payload");
    if (item.projectId !== project.projectId || identities.has(item.versionId))
      return jiraReadFailure("conflict");
    identities.add(item.versionId);
  }
  return boundJiraReadResult(
    localJiraPage(
      versions.filter((item) => item !== undefined),
      startAt,
      maxResults,
    ),
  );
}
export function isJiraVersionRead(name: string): name is VersionRead {
  return name === "jira.versions" || name === "jira.version";
}
export function isJiraVersionMutation(name: string): name is VersionWrite {
  return name === "jira.create-version" || name === "jira.update-version";
}
export async function executeJiraVersionRead(
  name: VersionRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const input = readInput(name, args);
  if (input === undefined) return jiraReadFailure("invalid-input");
  return name === "jira.versions"
    ? listVersions(request, input.target, input.startAt, input.maxResults)
    : asRead(await readVersion(request, input.target));
}
interface ReadInput {
  readonly target: string;
  readonly startAt: number;
  readonly maxResults: number;
}
function readInput(name: VersionRead, args: CatalogJsonObject): ReadInput | undefined {
  const list = name === "jira.versions";
  const field = list ? "projectIdOrKey" : "versionId";
  const target = args[field];
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  const allowed = new Set(list ? [field, "startAt", "maxResults"] : [field]);
  if (
    Object.keys(args).some((key) => !allowed.has(key)) ||
    !isSafeAtlassianIdentifier(target) ||
    (!list && !versionId(target)) ||
    !validPage(startAt, maxResults)
  )
    return undefined;
  return { target, startAt: startAt as number, maxResults: maxResults as number };
}
function validPage(startAt: unknown, maxResults: unknown): boolean {
  return (
    typeof startAt === "number" &&
    Number.isSafeInteger(startAt) &&
    startAt >= 0 &&
    startAt <= 1_000_000 &&
    typeof maxResults === "number" &&
    Number.isSafeInteger(maxResults) &&
    maxResults >= 1 &&
    maxResults <= 100
  );
}
interface MutationInput {
  readonly target: string;
  readonly fields: CatalogJsonObject;
}
function mutationInput(
  operation: VersionWrite,
  args: CatalogJsonObject,
): MutationInput | undefined {
  const create = operation === "jira.create-version";
  const selector = create ? "projectId" : "versionId";
  const target = args[selector];
  if (!versionId(target) || (create && projectNumber(target) === undefined)) return undefined;
  const fields = Object.entries(args).filter(([key]) => key !== selector);
  if (
    fields.length === 0 ||
    !fields.every(([key, value]) => validField(key, value)) ||
    (create && !validField("name", args.name))
  )
    return undefined;
  return { target, fields: Object.fromEntries(fields) };
}
function matches(version: VersionView, fields: CatalogJsonObject): boolean {
  return Object.entries(fields).every(([field, expected]) => version[field] === expected);
}
async function confirmVersion(
  request: JiraMutationRequest,
  identity: { readonly versionId: string; readonly projectId: string },
  fields: CatalogJsonObject,
): Promise<JiraVersionMutationAttempt> {
  const receipt = { versionId: identity.versionId };
  const result = await readVersion(request, identity.versionId);
  if (!result.ok) return { ...result, receipt };
  return result.version.projectId === identity.projectId && matches(result.version, fields)
    ? { ok: true, receipt }
    : { ok: false, reason: "conflict", receipt };
}
async function createVersion(
  request: JiraMutationRequest,
  input: MutationInput,
  check: boolean,
): Promise<JiraVersionMutationAttempt> {
  const project = await readProjectId(request, input.target);
  if (!project.ok) return project;
  if (check) return { ok: true, receipt: {} };
  const response = await request("version", "POST", {
    ...input.fields,
    projectId: projectNumber(project.projectId),
  });
  if (!response.ok) return dispatchFailure(response);
  const id = response.body?.id;
  if (response.status !== 201 || !versionId(id)) return MALFORMED;
  return confirmVersion(request, { versionId: id, projectId: project.projectId }, input.fields);
}
async function updateVersion(
  request: JiraMutationRequest,
  input: MutationInput,
  check: boolean,
): Promise<JiraVersionMutationAttempt> {
  const prior = await readVersion(request, input.target);
  if (!prior.ok) return prior;
  const receipt = { versionId: prior.version.versionId };
  if (matches(prior.version, input.fields))
    return {
      ok: false,
      reason: "conflict",
      receipt,
      detail: { messages: ["The version already holds these values. Nothing was written."] },
    };
  if (check) return { ok: true, receipt: {} };
  // PUT's native response is status-only; the following GET supplies the independent evidence.
  const response = await request(`version/${receipt.versionId}`, "PUT", input.fields, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status !== 200) return { ...MALFORMED, receipt };
  return confirmVersion(request, prior.version, input.fields);
}
/** One effect at most; the caller retains custody, authority, deadlines and durable no-replay. */
export function executeJiraVersionMutation(
  operation: VersionWrite,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraVersionMutationAttempt> {
  const input = mutationInput(operation, args);
  if (input === undefined) return Promise.resolve(INVALID);
  return operation === "jira.create-version"
    ? createVersion(request, input, check)
    : updateVersion(request, input, check);
}
