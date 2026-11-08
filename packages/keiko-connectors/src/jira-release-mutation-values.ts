import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraComponentSummary } from "./jira-managed-components.js";
import { jiraVersionSummary } from "./jira-managed-versions.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import { readSavedActor, savedText } from "./jira-saved-configuration-values.js";

export type ReleaseEntityKind = "component" | "version";
export interface JiraReleaseMutationReceipt extends JiraMutationReceipt {
  readonly replacementComponentId?: string;
  readonly targetVersionId?: string;
  readonly replacementVersionIds?: readonly string[];
}
export type ReleaseFailure = Omit<
  Extract<JiraMutationAttempt, { readonly ok: false }>,
  "receipt"
> & { readonly receipt?: JiraReleaseMutationReceipt };
export type JiraReleaseMutationAttempt =
  ReleaseFailure | { readonly ok: true; readonly receipt: JiraReleaseMutationReceipt };
export type ReleaseObservation<T> = ReleaseFailure | { readonly ok: true; readonly value: T };
export interface ReleaseContext {
  readonly projectId: string;
  readonly projectKey: string;
  readonly userKey: string;
}
export interface ReleaseEntity {
  readonly id: string;
  readonly snapshot: CatalogJsonObject;
}
export interface ReleaseSelection {
  readonly id: string;
  readonly projectId: string;
  readonly actorKey: string;
  readonly snapshot: CatalogJsonObject;
}
const COMPONENT_FIELDS = [
  "name",
  "description",
  "leadUserName",
  "assigneeType",
  "archived",
  "deleted",
] as const;
const VERSION_FIELDS = [
  "name",
  "description",
  "startDate",
  "releaseDate",
  "released",
  "archived",
] as const;
const ASSIGNEES = new Set(["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"]);
const BOOLEAN_FIELDS = new Set(["archived", "released", "deleted"]);
const DATE_FIELDS = new Set(["startDate", "releaseDate"]);
export const RELEASE_MALFORMED: ReleaseFailure = { ok: false, reason: "malformed-payload" };
export function releaseInvalid(message: string): ReleaseFailure {
  return {
    ok: false,
    reason: "field-validation",
    detail: { validation: "invalid-field", messages: [message] },
  };
}
export function releaseConflict(message: string): ReleaseFailure {
  return { ok: false, reason: "conflict", detail: { messages: [message] } };
}
export function releaseUnconfirmed(
  message: string,
  receipt: JiraReleaseMutationReceipt,
): ReleaseFailure {
  return { ok: false, reason: "unavailable", detail: { messages: [message] }, receipt };
}
export function releaseExactFields(value: CatalogJsonObject, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}
function date(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function snapshotField(field: string, value: unknown): value is string | boolean | null {
  if (field === "name") return savedText(value, 255);
  if (value === null) return true;
  if (BOOLEAN_FIELDS.has(field)) return typeof value === "boolean";
  if (DATE_FIELDS.has(field)) return date(value);
  if (field === "assigneeType") return typeof value === "string" && ASSIGNEES.has(value);
  return savedText(value, field === "description" ? 32768 : 255, field === "description");
}
/** Explicit null means native metadata was not supplied; it never means false or empty text. */
export function releaseSnapshot(
  kind: ReleaseEntityKind,
  value: unknown,
): CatalogJsonObject | undefined {
  const source = asRecord(value);
  const fields = kind === "component" ? COMPONENT_FIELDS : VERSION_FIELDS;
  if (source === undefined || Object.keys(source).length !== fields.length) return undefined;
  const snapshot: Record<string, string | boolean | null> = {};
  for (const field of fields) {
    const selected = source[field];
    if (!Object.hasOwn(source, field) || !snapshotField(field, selected)) return undefined;
    snapshot[field] = selected;
  }
  return snapshot;
}
export function releaseSelection(
  kind: ReleaseEntityKind,
  args: CatalogJsonObject,
): ReleaseSelection | undefined {
  const id = args[kind === "component" ? "componentId" : "versionId"];
  const snapshot = releaseSnapshot(
    kind,
    args[kind === "component" ? "expectedComponentSnapshot" : "expectedVersionSnapshot"],
  );
  return !jiraNativeId(id) ||
    !jiraNativeId(args.expectedProjectId) ||
    !savedText(args.expectedActorKey, 255) ||
    snapshot === undefined
    ? undefined
    : { id, snapshot, projectId: args.expectedProjectId, actorKey: args.expectedActorKey };
}
export function releaseSnapshotMatches(
  actual: CatalogJsonObject,
  expected: CatalogJsonObject,
): boolean {
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([field, value]) => actual[field] === value)
  );
}
export async function readReleaseContext(
  request: JiraMutationRequest,
  selected: ReleaseSelection,
): Promise<ReleaseObservation<ReleaseContext>> {
  const actor = await readSavedActor(request, selected.actorKey);
  if (!actor.ok) return actor;
  const project = await readJiraBoundProject(request, selected.projectId);
  if (!project.ok) return project;
  return {
    ok: true,
    value: {
      projectId: project.project.projectId,
      projectKey: project.project.projectKey,
      userKey: actor.value.key,
    },
  };
}
function versionParent(
  raw: Record<string, unknown>,
  context: ReleaseContext,
  collection: boolean,
): boolean {
  const projectId = raw.projectId;
  if (projectId === undefined || projectId === null) {
    if (!collection) return false;
  } else if (typeof projectId !== "number" || jiraNativeNumericId(projectId) !== context.projectId)
    return false;
  return (
    raw.project === undefined ||
    raw.project === null ||
    (isSafeAtlassianIdentifier(raw.project) && raw.project === context.projectKey)
  );
}
function entity(
  kind: ReleaseEntityKind,
  value: unknown,
  context: ReleaseContext,
  collection: boolean,
): ReleaseEntity | undefined {
  const raw = asRecord(value);
  const summary = kind === "component" ? jiraComponentSummary(raw) : jiraVersionSummary(raw);
  if (raw === undefined || summary === undefined) return undefined;
  const id = kind === "component" ? summary.id : summary.versionId;
  if (!jiraNativeId(id)) return undefined;
  const parent =
    kind === "component"
      ? summary.project === context.projectKey
      : versionParent(raw, context, collection);
  if (
    !parent ||
    (raw.self !== undefined &&
      raw.self !== null &&
      !jiraResourceSelfMatches(raw.self, `${kind}/${id}`))
  )
    return undefined;
  const fields = kind === "component" ? COMPONENT_FIELDS : VERSION_FIELDS;
  const snapshot = releaseSnapshot(
    kind,
    Object.fromEntries(fields.map((field) => [field, summary[field] ?? null])),
  );
  return snapshot === undefined ? undefined : { id, snapshot };
}
export async function readReleaseEntity(
  request: JiraMutationRequest,
  kind: ReleaseEntityKind,
  id: string,
  context: ReleaseContext,
): Promise<ReleaseObservation<ReleaseEntity>> {
  const response = await request(`${kind}/${id}`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const observed =
    response.status === 200 ? entity(kind, response.body, context, false) : undefined;
  if (observed === undefined) return RELEASE_MALFORMED;
  return observed.id === id
    ? { ok: true, value: observed }
    : releaseConflict(
        "The native entity identity differs from the reviewed selection. Nothing was written.",
      );
}
export async function readReleaseCollection(
  request: JiraMutationRequest,
  kind: ReleaseEntityKind,
  context: ReleaseContext,
): Promise<ReleaseObservation<readonly ReleaseEntity[]>> {
  const response = await request(
    `project/${context.projectId}/${kind === "component" ? "components" : "versions"}`,
    "GET",
    undefined,
    "json-array",
  );
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return RELEASE_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const items: ReleaseEntity[] = [];
  const ids = new Set<string>();
  for (const value of response.items) {
    const observed = entity(kind, value, context, true);
    if (observed === undefined || ids.has(observed.id)) return RELEASE_MALFORMED;
    items.push(observed);
    ids.add(observed.id);
  }
  return { ok: true, value: items };
}
export async function reviewedReleaseEntity(
  request: JiraMutationRequest,
  kind: ReleaseEntityKind,
  id: string,
  expected: CatalogJsonObject,
  context: ReleaseContext,
): Promise<ReleaseObservation<ReleaseEntity>> {
  const current = await readReleaseEntity(request, kind, id, context);
  if (!current.ok) return current;
  return releaseSnapshotMatches(current.value.snapshot, expected)
    ? current
    : releaseConflict(
        "The native metadata changed after review. Review the current exact identity, parent and full metadata snapshot before requesting this change. Nothing was written.",
      );
}
export function releaseReceipt(
  kind: ReleaseEntityKind,
  selected: ReleaseSelection,
  context: ReleaseContext,
): JiraReleaseMutationReceipt {
  return {
    ...context,
    ...(kind === "component" ? { componentId: selected.id } : { versionId: selected.id }),
  };
}
/** Body DTO Long fields cannot carry an imprecise JSON number. Paths retain the full int64 string. */
export function releaseNativeNumber(value: unknown): number | undefined {
  if (!jiraNativeId(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
