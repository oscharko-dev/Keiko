import {
  isSafeAtlassianIdentifier,
  JIRA_FIELD_ID_PATTERN,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import type { JiraReportFieldCatalogEntry } from "./jira-report-types.js";

/** Custom field types that Jira Software and Portfolio define; ids are read from the instance. */
const EPIC_LINK_TYPE = "com.pyxis.greenhopper.jira:gh-epic-link";
const EPIC_NAME_TYPE = "com.pyxis.greenhopper.jira:gh-epic-label";
const PARENT_LINK_TYPE = "com.atlassian.jpo:jpo-custom-field-parent";
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
  readonly parentFieldIds: readonly string[];
  readonly epicNameFieldId: string | undefined;
}

function fieldType(item: unknown): { readonly id: string; readonly custom: unknown } | undefined {
  const record = asRecord(item);
  if (typeof record?.id !== "string" || !FIELD_ID.test(record.id)) return undefined;
  return { id: record.id, custom: asRecord(record.schema)?.custom };
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

/** Hierarchy fields by their Jira field type, so no instance-specific id is ever assumed. */
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
      epicNameFieldId: undefined,
    };
  const fields = outcome.items.flatMap((item) => fieldType(item) ?? []);
  return {
    discovery: "complete",
    catalog: catalogOf(outcome.items),
    parentFieldIds: fields
      .filter((field) => field.custom === EPIC_LINK_TYPE || field.custom === PARENT_LINK_TYPE)
      .map((field) => field.id)
      .sort(compareStrings),
    epicNameFieldId: fields.find((field) => field.custom === EPIC_NAME_TYPE)?.id,
  };
}

function requirementState(read: number, wanted: number): JiraReportRequiredFields["state"] {
  if (read === wanted) return "applied";
  return read === 0 ? "unavailable" : "partial";
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
  return {
    state: requirementState(byType.size, ids.length),
    ...(reason === undefined ? {} : { reason }),
    byType,
  };
}
