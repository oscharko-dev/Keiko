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
    return typeof record?.id === "string" && FIELD_ID.test(record.id)
      ? [{ id: record.id, name: typeof record.name === "string" ? record.name : record.id }]
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
  return { discovery: "complete", catalog, parentFieldIds: candidates };
}

export interface JiraReportRequiredFields {
  readonly state: "applied" | "partial" | "unavailable";
  readonly reason?: JiraReportFailure;
  readonly byType: ReadonlyMap<string, readonly string[]>;
  /** Numeric estimate candidates actually present on this project's create screens. */
  readonly estimateFields?: readonly JiraReportFieldCatalogEntry[];
  readonly timeTracking?: boolean;
}

function screenEstimateField(value: unknown): readonly JiraReportFieldCatalogEntry[] {
  const field = asRecord(value);
  if (typeof field?.fieldId !== "string" || !FIELD_ID.test(field.fieldId)) return [];
  const schema = asRecord(field.schema);
  if (typeof field.name !== "string" || schema?.type !== "number") return [];
  const key = schema.custom;
  return [
    {
      id: field.fieldId,
      name: field.name.trim(),
      ...(typeof key === "string" ? { schemaKey: key } : {}),
    },
  ];
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
type PageEnd = "last" | "more" | "malformed";
/** The collection size a page states: absent, a valid count, or `invalid` when it is neither. */
function statedTotal(body: Record<string, unknown>): number | undefined | "invalid" {
  const { total } = body;
  if (total === undefined) return undefined;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : "invalid";
}
/** A page that starts where asked and states no total that is not a count. */
function coherent(body: Record<string, unknown>, startAt: number): boolean {
  return (body.startAt ?? startAt) === startAt && statedTotal(body) !== "invalid";
}
function nextPage(body: Record<string, unknown>, read: number, total: number | undefined): PageEnd {
  if (total === undefined && body.isLast !== false) return "malformed";
  return read > 0 ? "more" : "malformed";
}
/**
 * Whether a createmeta page ends its collection. Jira's own completion statement (`isLast`) or a
 * total this page reaches settles it, and the two must agree: a page that starts elsewhere than
 * asked, that states a total it has not reached while calling itself last, or that is empty without
 * either statement proves nothing and is malformed, never an empty rule set.
 */
function pageEnd(body: Record<string, unknown>, startAt: number, read: number): PageEnd {
  const total = statedTotal(body);
  if (!coherent(body, startAt) || total === "invalid") return "malformed";
  const reached = total !== undefined && startAt + read >= total;
  if (body.isLast === true) return total === undefined || reached ? "last" : "malformed";
  if (reached) return "last";
  return nextPage(body, read, total);
}
/** Every page of one createmeta collection; the failure reason when a page cannot be read. */
export async function collectJiraReportMetadataPages(
  http: Pick<JiraReportHttp, "getRecord">,
  path: string,
  startAt: number,
  into: unknown[],
  maxItems = Number.MAX_SAFE_INTEGER,
): Promise<JiraReportFailure | undefined> {
  const outcome = await http.getRecord(
    `${path}${path.includes("?") ? "&" : "?"}startAt=${String(startAt)}&maxResults=${String(METADATA_PAGE_SIZE)}`,
  );
  if (!outcome.ok) return outcome.reason;
  const values = asArray(outcome.body.values);
  if (values === undefined) return "malformed-payload";
  const end = pageEnd(outcome.body, startAt, values.length);
  if (end === "malformed") return "malformed-payload";
  into.push(...values);
  if (into.length > maxItems) return "bounds-exceeded";
  return end === "last"
    ? undefined
    : collectJiraReportMetadataPages(http, path, startAt + values.length, into, maxItems);
}
type TypeRequirements =
  | {
      readonly fields: readonly string[];
      readonly estimateFields: readonly JiraReportFieldCatalogEntry[];
      readonly timeTracking: boolean;
    }
  | { readonly reason: JiraReportFailure };
async function typeRequirements(
  http: JiraReportHttp,
  projectKey: string,
  typeId: string,
): Promise<TypeRequirements> {
  const values: unknown[] = [];
  const reason = await collectJiraReportMetadataPages(
    http,
    `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${typeId}`,
    0,
    values,
  );
  return reason === undefined
    ? {
        fields: requiredIds(values),
        estimateFields: values.flatMap(screenEstimateField),
        timeTracking: values.some((value) => asRecord(value)?.fieldId === "timetracking"),
      }
    : { reason };
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
    ? await collectJiraReportMetadataPages(
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
  const estimateFields = loaded.flatMap((item) => ("fields" in item ? item.estimateFields : []));
  const timeTracking = loaded.some((item) => "fields" in item && item.timeTracking);
  return {
    state,
    ...(reason === undefined ? {} : { reason }),
    byType,
    estimateFields,
    timeTracking,
  };
}
