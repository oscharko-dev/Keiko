import {
  isSafeAtlassianIdentifier,
  JIRA_FIELD_ID_PATTERN,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { compareCodePoints } from "./jira-report-order.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import type { JiraReportFieldCatalogEntry } from "./jira-report-types.js";

/**
 * An app-defined field carries an opaque value shape: Jira reports its schema type as `any`. Both
 * the field's id and the key of its field type are the instance's own and are never named here.
 */
const OPAQUE_SCHEMA_TYPE = "any";
/** More candidates than this are not read blindly: the caller names the parent fields instead. */
const PARENT_CANDIDATES_MAX = 24;
const FIELD_ID = new RegExp(JIRA_FIELD_ID_PATTERN, "u");
/** Always present and never an author's omission, so never a required-field deviation. */
const SYSTEM_FIELDS: ReadonlySet<string> = new Set(["project", "issuetype", "reporter"]);
const METADATA_PAGE_SIZE = 50;

const CATALOG_MAX = 5000;

export type JiraReportFailure = AtlassianConnectorWriteFailureReason;

export interface JiraReportHierarchyFields {
  readonly discovery: "complete" | "unavailable";
  /** Every field the instance lists, for template references by name; absent when unread. */
  readonly catalog: readonly JiraReportFieldCatalogEntry[] | undefined;
  readonly reason?: JiraReportFailure;
  /** Fields that may name an issue's parent; each value is checked against the issue-key shape. */
  readonly parentFieldIds: readonly string[];
}

/** A field an app defines (a custom type, no Jira system role) whose value shape Jira cannot state. */
function parentCandidateId(item: unknown): string | undefined {
  const record = asRecord(item);
  const schema = asRecord(record?.schema);
  if (typeof record?.id !== "string" || !FIELD_ID.test(record.id)) return undefined;
  if (typeof schema?.custom !== "string" || schema.system !== undefined) return undefined;
  return schema.type === OPAQUE_SCHEMA_TYPE ? record.id : undefined;
}

function catalogOf(items: readonly unknown[]): readonly JiraReportFieldCatalogEntry[] | undefined {
  if (items.length > CATALOG_MAX) return undefined;
  return items.flatMap((item): readonly JiraReportFieldCatalogEntry[] => {
    const record = asRecord(item);
    return typeof record?.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name }]
      : [];
  });
}

/**
 * Parent-field candidates from the field list by schema shape alone, so no instance-specific id
 * and no app's field-type key is ever assumed; whether a candidate really holds a parent is
 * decided on the issues read, by the issue-key shape of its value.
 */
export async function discoverHierarchyFields(
  http: JiraReportHttp,
): Promise<JiraReportHierarchyFields> {
  const outcome = await http.getArray("field");
  if (!outcome.ok)
    return {
      discovery: "unavailable",
      reason: outcome.reason,
      catalog: undefined,
      parentFieldIds: [],
    };
  const catalog = catalogOf(outcome.items);
  const candidates = outcome.items
    .flatMap((item) => parentCandidateId(item) ?? [])
    .sort(compareCodePoints);
  if (candidates.length > PARENT_CANDIDATES_MAX)
    return { discovery: "unavailable", reason: "bounds-exceeded", catalog, parentFieldIds: [] };
  return { discovery: "complete", catalog, parentFieldIds: candidates };
}

export interface JiraReportRequiredFields {
  readonly state: "applied" | "partial" | "unavailable";
  readonly reason?: JiraReportFailure;
  readonly byType: ReadonlyMap<string, readonly string[]>;
}

function requiredIds(values: readonly unknown[]): readonly string[] {
  const ids: string[] = [];
  for (const value of values) {
    const record = asRecord(value);
    if (record?.required !== true || record.hasDefaultValue === true) continue;
    if (
      typeof record.fieldId === "string" &&
      FIELD_ID.test(record.fieldId) &&
      !SYSTEM_FIELDS.has(record.fieldId)
    )
      ids.push(record.fieldId);
  }
  return ids;
}
/** Every page of one createmeta collection; the failure reason when a page cannot be read. */
async function collectPages(
  http: JiraReportHttp,
  path: string,
  startAt: number,
  into: unknown[],
): Promise<JiraReportFailure | undefined> {
  const outcome = await http.getRecord(
    `${path}?startAt=${String(startAt)}&maxResults=${String(METADATA_PAGE_SIZE)}`,
  );
  if (!outcome.ok) return outcome.reason;
  const values = asArray(outcome.body.values);
  if (values === undefined) return "malformed-payload";
  into.push(...values);
  const total = outcome.body.total;
  const last =
    outcome.body.isLast === true ||
    values.length === 0 ||
    (typeof total === "number" && startAt + values.length >= total);
  return last ? undefined : collectPages(http, path, startAt + values.length, into);
}
type TypeRequirements =
  { readonly fields: readonly string[] } | { readonly reason: JiraReportFailure };
async function typeRequirements(
  http: JiraReportHttp,
  projectKey: string,
  typeId: string,
): Promise<TypeRequirements> {
  const values: unknown[] = [];
  const reason = await collectPages(
    http,
    `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${typeId}`,
    0,
    values,
  );
  return reason === undefined ? { fields: requiredIds(values) } : { reason };
}

function requiredState(read: number, expected: number): JiraReportRequiredFields["state"] {
  if (read === expected) return "applied";
  return read === 0 ? "unavailable" : "partial";
}

/** Fields the instance requires on create, per issue type of a project (current metadata). */
export async function loadRequiredFields(
  http: JiraReportHttp,
  projectKey: string,
): Promise<JiraReportRequiredFields> {
  const types: unknown[] = [];
  const typesReason = isSafeAtlassianIdentifier(projectKey)
    ? await collectPages(
        http,
        `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
        0,
        types,
      )
    : "field-validation";
  if (typesReason !== undefined)
    return { state: "unavailable", reason: typesReason, byType: new Map() };
  const ids = types.flatMap((type) => {
    const id = asRecord(type)?.id;
    return typeof id === "string" && /^\d{1,32}$/u.test(id) ? [id] : [];
  });
  const loaded = await Promise.all(ids.map((id) => typeRequirements(http, projectKey, id)));
  const byType = new Map<string, readonly string[]>();
  let reason: JiraReportFailure | undefined;
  loaded.forEach((item, index) => {
    const id = ids[index];
    if ("fields" in item && id !== undefined) byType.set(id, item.fields);
    else if ("reason" in item) reason = item.reason;
  });
  const state = requiredState(byType.size, ids.length);
  return { state, ...(reason === undefined ? {} : { reason }), byType };
}
