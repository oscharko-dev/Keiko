import {
  isSafeAtlassianIdentifier,
  type JiraFieldMetadata,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { projectJiraFieldReadValue } from "./jira-managed-field-reads.js";
import {
  projectJiraFieldReference,
  type JiraFieldValidationResult,
} from "./jira-field-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraIssueLinksPresent, type JiraIssueLinkRequest } from "./jira-issue-links.js";

type Failure = Extract<JiraMutationAttempt, { ok: false }>;
export type JiraIssueReadback =
  | Failure
  | {
      readonly ok: true;
      readonly id: string;
      readonly fields: Record<string, unknown>;
    };
export type JiraValidatedMutationFields = Extract<JiraFieldValidationResult, { ok: true }> & {
  readonly links?: readonly JiraIssueLinkRequest[];
};
export interface JiraFieldConfirmation {
  readonly issueKey: string;
  readonly receipt: JiraMutationReceipt;
  readonly metadata: readonly JiraFieldMetadata[];
  readonly values: JiraValidatedMutationFields;
  readonly prior?: Extract<JiraIssueReadback, { ok: true }>;
  readonly targetStatusId?: string;
}
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
const CONFLICT = { ok: false, reason: "conflict" } as const;

/** A bounded direct resource read; matching a search result is never attribution. */
export async function readJiraMutationIssue(
  request: JiraMutationRequest,
  issueKey: string,
  fields: readonly string[],
): Promise<JiraIssueReadback> {
  const query = new URLSearchParams({
    fields: [...new Set(fields)].sort(compareStrings).join(","),
  });
  const response = await request(`issue/${encodeURIComponent(issueKey)}?${query.toString()}`);
  if (!response.ok) return response;
  const body = response.body;
  if (response.status !== 200 || body === undefined) return MALFORMED;
  const values = asRecord(body.fields);
  if (
    values === undefined ||
    !isSafeAtlassianIdentifier(body.key) ||
    !isSafeAtlassianIdentifier(body.id)
  )
    return MALFORMED;
  if (body.key.toUpperCase() !== issueKey.toUpperCase() && body.id !== issueKey) return CONFLICT;
  return { ok: true, id: body.id, fields: values };
}
export function jiraMutationFieldSelection(
  values: JiraValidatedMutationFields,
  transition = false,
): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(values.fields),
      ...Object.keys(values.update),
      ...((values.links?.length ?? 0) > 0 ? ["issuelinks"] : []),
      ...(transition ? ["status"] : []),
    ]),
  ];
}
/** An issue reference compares by key and, when only an id was written, by id. */
function issueComparable(value: unknown, expected: unknown): string | undefined {
  if (value === null) return "null";
  const raw = asRecord(value);
  const wanted = asRecord(expected);
  if (raw === undefined) return undefined;
  if (wanted?.id !== undefined) return typeof raw.id === "string" ? `id:${raw.id}` : undefined;
  return typeof raw.key === "string" ? `key:${raw.key.toUpperCase()}` : undefined;
}
// Jira reshapes opaque values on read (a sprint id reads back as a sprint object), so only
// presence is confirmed; Jira's own write validation is authoritative for the content.
function opaqueComparable(value: unknown): string {
  return value === null || (Array.isArray(value) && value.length === 0) || value === ""
    ? "null"
    : "present";
}
function comparable(
  field: JiraFieldMetadata,
  value: unknown,
  expected: unknown = value,
): string | undefined {
  if (field.kind === "issue") return issueComparable(value, expected);
  if (field.kind === "opaque") return opaqueComparable(value);
  return typedComparable(field, value);
}
function typedComparable(field: JiraFieldMetadata, value: unknown): string | undefined {
  const projected = projectJiraFieldReadValue(field, value);
  if (projected.state === "empty") return "null";
  if (projected.state !== "value") return undefined;
  const scalars = projected.text ?? projected.number;
  if (scalars !== undefined) return JSON.stringify(scalars);
  const items = comparableItems(
    projected,
    field.kind === "user" || field.kind === "users" ? "name" : "id",
  );
  return items === undefined ? undefined : JSON.stringify([...new Set(items)].sort(compareStrings));
}
function comparableItems(projected: CatalogJsonObject, key: string): readonly string[] | undefined {
  const strings = asArray(projected.strings);
  if (strings?.every((value): value is string => typeof value === "string")) return strings;
  const references = asArray(projected.references)?.map((value) => asRecord(value)?.[key]);
  return references?.every((value): value is string => typeof value === "string")
    ? references
    : undefined;
}
function setsMatch(input: JiraFieldConfirmation, current: Record<string, unknown>): boolean {
  return Object.entries(input.values.fields).every(([id, expected]) => {
    const field = input.metadata.find((value) => value.id === id);
    if (field === undefined || !Object.hasOwn(current, id)) return false;
    const wanted = comparable(field, expected);
    return wanted !== undefined && comparable(field, current[id], expected) === wanted;
  });
}
function updatedLabels(values: JiraValidatedMutationFields): ReadonlyMap<string, boolean> {
  const result = new Map<string, boolean>();
  for (const update of values.update.labels ?? []) {
    if (update.add !== undefined) result.set(update.add, true);
    if (update.remove !== undefined) result.set(update.remove, false);
  }
  return result;
}
function labels(value: unknown): ReadonlySet<string> | undefined {
  if (value === null) return new Set();
  const items = asArray(value);
  return items !== undefined &&
    items.length <= 100 &&
    items.every((item): item is string => typeof item === "string")
    ? new Set(items)
    : undefined;
}
function updatesMatch(
  values: JiraValidatedMutationFields,
  current: Record<string, unknown>,
): boolean {
  if (values.links !== undefined && !jiraIssueLinksPresent(current.issuelinks, values.links))
    return false;
  const expected = updatedLabels(values);
  if (expected.size === 0) return true;
  const actual = labels(current.labels);
  return (
    actual !== undefined && [...expected].every(([label, present]) => actual.has(label) === present)
  );
}
function fieldChanged(
  metadata: readonly JiraFieldMetadata[],
  id: string,
  expected: unknown,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const field = metadata.find((value) => value.id === id);
  if (field === undefined) return false;
  if (field.kind === "opaque")
    return JSON.stringify(before[id] ?? null) !== JSON.stringify(after[id] ?? null);
  const prior = comparable(field, before[id], expected);
  return prior !== undefined && prior !== comparable(field, after[id], expected);
}
function linksAdded(values: JiraValidatedMutationFields, before: Record<string, unknown>): boolean {
  return (values.links ?? []).some((link) => !jiraIssueLinksPresent(before.issuelinks, [link]));
}
function relevantChange(input: JiraFieldConfirmation, current: Record<string, unknown>): boolean {
  const prior = input.prior;
  if (prior === undefined) return true; // Creation is attributed by its fresh returned identity.
  if (input.targetStatusId !== undefined)
    return (
      asRecord(prior.fields.status)?.id !== input.targetStatusId &&
      isSafeAtlassianIdentifier(asRecord(prior.fields.status)?.id)
    );
  const setsChanged = Object.entries(input.values.fields).some(([id, expected]) =>
    fieldChanged(input.metadata, id, expected, prior.fields, current),
  );
  const beforeLabels = labels(prior.fields.labels);
  return (
    setsChanged ||
    linksAdded(input.values, prior.fields) ||
    (beforeLabels !== undefined &&
      [...updatedLabels(input.values)].some(
        ([label, present]) => beforeLabels.has(label) !== present,
      ))
  );
}
function identityMatches(
  input: JiraFieldConfirmation,
  current: Extract<JiraIssueReadback, { ok: true }>,
): boolean {
  const expectedId = input.receipt.issueId ?? input.prior?.id;
  return expectedId === undefined || expectedId === current.id;
}
export async function confirmJiraMutationFields(
  request: JiraMutationRequest,
  input: JiraFieldConfirmation,
): Promise<JiraMutationAttempt> {
  const current = await readJiraMutationIssue(
    request,
    input.issueKey,
    jiraMutationFieldSelection(input.values, input.targetStatusId !== undefined),
  );
  if (!current.ok) return current;
  if (
    !identityMatches(input, current) ||
    !setsMatch(input, current.fields) ||
    !updatesMatch(input.values, current.fields)
  )
    return CONFLICT;
  if (
    input.targetStatusId !== undefined &&
    asRecord(current.fields.status)?.id !== input.targetStatusId
  )
    return CONFLICT;
  return relevantChange(input, current.fields) ? { ok: true, receipt: input.receipt } : CONFLICT;
}
export async function confirmJiraComment(
  request: JiraMutationRequest,
  issueKey: string,
  commentId: string,
  body: string,
): Promise<JiraMutationAttempt> {
  const response = await request(
    `issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
  );
  if (!response.ok) return response;
  if (response.status !== 200 || response.body === undefined) return MALFORMED;
  return response.body.id === commentId && response.body.body === body
    ? { ok: true, receipt: { issueKey, commentId } }
    : CONFLICT;
}
function assignee(value: unknown): string | null | undefined {
  if (value === null) return null;
  const name = projectJiraFieldReference(value)?.name;
  return typeof name === "string" ? name : undefined;
}
export async function confirmJiraAssignment(
  request: JiraMutationRequest,
  issueKey: string,
  name: string | null,
  prior: Extract<JiraIssueReadback, { ok: true }>,
): Promise<JiraMutationAttempt> {
  const current = await readJiraMutationIssue(request, issueKey, ["assignee"]);
  if (!current.ok) return current;
  const before = assignee(prior.fields.assignee);
  return current.id === prior.id &&
    before !== undefined &&
    before !== name &&
    assignee(current.fields.assignee) === name
    ? { ok: true, receipt: { issueKey } }
    : CONFLICT;
}
