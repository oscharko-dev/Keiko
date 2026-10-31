import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraReportHttp } from "./jira-report-http.js";

/** Custom field types that Jira Software and Portfolio define; ids are read from the instance. */
const EPIC_LINK_TYPE = "com.pyxis.greenhopper.jira:gh-epic-link";
const EPIC_NAME_TYPE = "com.pyxis.greenhopper.jira:gh-epic-label";
const PARENT_LINK_TYPE = "com.atlassian.jpo:jpo-custom-field-parent";
const FIELD_ID = /^(?:[a-z][a-z0-9]*|customfield_\d{1,16})$/u;
/** Always present and never an author's omission, so never a required-field deviation. */
const SYSTEM_FIELDS: ReadonlySet<string> = new Set(["project", "issuetype", "reporter"]);
const METADATA_PAGE_SIZE = 50;

export interface JiraReportHierarchyFields {
  readonly discovery: "complete" | "unavailable";
  readonly parentFieldIds: readonly string[];
  readonly epicNameFieldId: string | undefined;
}

function fieldType(item: unknown): { readonly id: string; readonly custom: unknown } | undefined {
  const record = asRecord(item);
  if (typeof record?.id !== "string" || !FIELD_ID.test(record.id)) return undefined;
  return { id: record.id, custom: asRecord(record.schema)?.custom };
}

/** Hierarchy fields by their Jira field type, so no instance-specific id is ever assumed. */
export async function discoverHierarchyFields(
  http: JiraReportHttp,
): Promise<JiraReportHierarchyFields> {
  const outcome = await http.getArray("field");
  if (!outcome.ok)
    return { discovery: "unavailable", parentFieldIds: [], epicNameFieldId: undefined };
  const fields = outcome.items.flatMap((item) => fieldType(item) ?? []);
  return {
    discovery: "complete",
    parentFieldIds: fields
      .filter((field) => field.custom === EPIC_LINK_TYPE || field.custom === PARENT_LINK_TYPE)
      .map((field) => field.id)
      .sort(),
    epicNameFieldId: fields.find((field) => field.custom === EPIC_NAME_TYPE)?.id,
  };
}

export interface JiraReportRequiredFields {
  readonly state: "applied" | "partial" | "unavailable";
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
/** Every page of one createmeta collection; false when a page cannot be read. */
async function collectPages(
  http: JiraReportHttp,
  path: string,
  startAt: number,
  into: unknown[],
): Promise<boolean> {
  const outcome = await http.getRecord(
    `${path}?startAt=${String(startAt)}&maxResults=${String(METADATA_PAGE_SIZE)}`,
  );
  const values = outcome.ok ? asArray(outcome.body.values) : undefined;
  if (!outcome.ok || values === undefined) return false;
  into.push(...values);
  const total = outcome.body.total;
  const last =
    outcome.body.isLast === true ||
    values.length === 0 ||
    (typeof total === "number" && startAt + values.length >= total);
  return last ? true : collectPages(http, path, startAt + values.length, into);
}
async function typeRequirements(
  http: JiraReportHttp,
  projectKey: string,
  typeId: string,
): Promise<readonly string[] | undefined> {
  const values: unknown[] = [];
  const read = await collectPages(
    http,
    `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${typeId}`,
    0,
    values,
  );
  return read ? requiredIds(values) : undefined;
}

/** Fields the instance requires on create, per issue type of a project (current metadata). */
export async function loadRequiredFields(
  http: JiraReportHttp,
  projectKey: string,
): Promise<JiraReportRequiredFields> {
  const types: unknown[] = [];
  if (
    !isSafeAtlassianIdentifier(projectKey) ||
    !(await collectPages(
      http,
      `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      0,
      types,
    ))
  )
    return { state: "unavailable", byType: new Map() };
  const ids = types.flatMap((type) => {
    const id = asRecord(type)?.id;
    return typeof id === "string" && /^\d{1,32}$/u.test(id) ? [id] : [];
  });
  const loaded = await Promise.all(ids.map((id) => typeRequirements(http, projectKey, id)));
  const byType = new Map<string, readonly string[]>();
  loaded.forEach((fields, index) => {
    const id = ids[index];
    if (id !== undefined && fields !== undefined) byType.set(id, fields);
  });
  return {
    state: byType.size === ids.length ? "applied" : byType.size === 0 ? "unavailable" : "partial",
    byType,
  };
}
