import { JIRA_FIELD_ID_PATTERN } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
// Capability validation only: HTTP, authority, custody and audit remain with their existing owners.
import type {
  AtlassianConnectorDeployment,
  JiraFieldKind,
  JiraFieldMetadata,
  JiraFieldOperation,
  JiraFieldReference,
  JiraFieldUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { composePlainTextToAdf } from "./plain-text-to-adf.js";

export const JIRA_METADATA_MAX_FIELDS = 500;
export const JIRA_METADATA_MAX_UPDATES = 50;
const MAX_VALUES = 100;
const FIELD_ID = new RegExp(JIRA_FIELD_ID_PATTERN, "u");
const FORBIDDEN = new Set(["constructor", "prototype", "__proto__"]);
const CUSTOM_PREFIX = "com.atlassian.jira.plugin.system.customfieldtypes:";
const STANDARD: Readonly<Record<string, JiraFieldKind>> = {
  summary: "text",
  description: "text",
  environment: "text",
  labels: "strings",
  priority: "option",
  resolution: "option",
  assignee: "user",
  reporter: "user",
  duedate: "date",
  components: "options",
  versions: "options",
  fixVersions: "options",
  project: "option",
  issuetype: "option",
};
const CUSTOM: Readonly<Record<string, JiraFieldKind>> = {
  textfield: "text",
  textarea: "text",
  float: "number",
  datepicker: "date",
  datetime: "datetime",
  select: "option",
  radiobuttons: "option",
  multiselect: "options",
  multicheckboxes: "options",
  userpicker: "user",
  multiuserpicker: "users",
};
// A plugin or unmapped custom field keeps the kind its declared schema type states (#4176).
const SCHEMA_TYPE: Readonly<Record<string, JiraFieldKind>> = {
  string: "text",
  number: "number",
  date: "date",
  datetime: "datetime",
  option: "option",
  user: "user",
};
// Written through their own tools or fixed by the create call; never a plain field write.
const DEDICATED_SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  "attachment",
  "comment",
  "issuelinks",
  "issuekey",
  "project",
  "issuetype",
  "status",
  "resolution",
  "created",
  "updated",
  "creator",
  "votes",
  "watches",
  "worklog",
  "thumbnail",
  "subtasks",
  "lastViewed",
  "aggregateprogress",
  "progress",
  "workratio",
  "timespent",
  "aggregatetimespent",
]);
const OPAQUE_MAX_BYTES = 16_384;
const OPAQUE_MAX_DEPTH = 4;
const OPERATIONS: ReadonlySet<string> = new Set(["set", "add", "remove"]);
const ARRAY_ITEM: Readonly<Record<string, string>> = {
  strings: "string",
  users: "user",
  options: "option",
};
// eslint-disable-next-line no-control-regex -- metadata and references must not contain control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function boundedText(value: unknown, max = 255): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value)
  );
}
export function isJiraFieldId(value: unknown): value is string {
  return boundedText(value, 64) && FIELD_ID.test(value) && !FORBIDDEN.has(value);
}
function systemKind(id: string, schema: Record<string, unknown>): JiraFieldKind | undefined {
  if (schema.system !== id) return undefined;
  if (Object.hasOwn(STANDARD, id)) return STANDARD[id];
  if (id === "parent") return "issue";
  return DEDICATED_SYSTEM_FIELDS.has(id) ? undefined : "opaque";
}
function declaredKind(id: string, schema: Record<string, unknown>): JiraFieldKind | undefined {
  if (schema.custom === undefined) return systemKind(id, schema);
  if (typeof schema.custom !== "string" || !id.startsWith("customfield_")) return undefined;
  // A plugin field's meaning is never guessed from a familiar base type: its value is opaque and
  // Jira's own validation decides (#4176). Only Jira's system custom types carry known semantics.
  if (!schema.custom.startsWith(CUSTOM_PREFIX)) return "opaque";
  const custom = schema.custom.slice(CUSTOM_PREFIX.length);
  if (Object.hasOwn(CUSTOM, custom)) return CUSTOM[custom];
  const type = schema.type;
  return typeof type === "string" && Object.hasOwn(SCHEMA_TYPE, type)
    ? SCHEMA_TYPE[type]
    : "opaque";
}
function expectedItem(id: string, item: string): string {
  if (id === "components") return "component";
  return id === "versions" || id === "fixVersions" ? "version" : item;
}
function fieldKind(id: string, schema: Record<string, unknown>): JiraFieldKind {
  const kind = declaredKind(id, schema);
  if (kind === undefined) return "unsupported";
  if (kind === "opaque") return kind;
  if (kind === "issue") return schema.type === "issuelink" ? kind : "unsupported";
  const item = ARRAY_ITEM[kind];
  if (item !== undefined)
    return schema.type === "array" && schema.items === expectedItem(id, item)
      ? kind
      : "unsupported";
  const expected =
    kind === "text" ? "string" : standardScalarType(id, kind, schema.custom !== undefined);
  return schema.type === expected ? kind : "unsupported";
}
function standardScalarType(id: string, kind: JiraFieldKind, custom: boolean): string {
  return kind === "option" && !custom ? id : kind;
}
export function projectJiraFieldReference(value: unknown): JiraFieldReference | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const result: { id?: string; name?: string; accountId?: string; label?: string } = {};
  for (const key of ["id", "name", "accountId"] as const) {
    const candidate = raw[key];
    if (boundedText(candidate, 256)) result[key] = candidate;
  }
  if (Object.keys(result).length === 0) return undefined;
  const label = raw.displayName ?? raw.value ?? raw.name;
  if (boundedText(label, 256)) result.label = label;
  return result;
}
function allowedReferences(value: unknown): readonly JiraFieldReference[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > 500) return undefined;
  const result: JiraFieldReference[] = [];
  for (const value of values) {
    const candidate = projectJiraFieldReference(value);
    if (candidate === undefined) return undefined;
    result.push(candidate);
  }
  return result;
}
function boundedReferences(
  kind: JiraFieldKind,
  value: unknown,
): Pick<JiraFieldMetadata, "kind" | "allowedValues"> | undefined {
  // Plugin-specific choice structures are never parsed; an opaque value is Jira's to validate.
  if (kind === "unsupported" || kind === "opaque" || value === undefined) return { kind };
  const values = asArray(value);
  if (values === undefined) return undefined;
  if (values.length > 500) return { kind: "unsupported" };
  const allowedValues = allowedReferences(values);
  return allowedValues === undefined ? undefined : { kind, allowedValues };
}
function supportedOperations(
  id: string,
  kind: JiraFieldKind,
  operations: readonly JiraFieldOperation[],
): readonly JiraFieldOperation[] {
  if (kind === "unsupported") return [];
  return [
    ...new Set(
      operations.filter(
        (operation) => operation === "set" || (id === "labels" && kind === "strings"),
      ),
    ),
  ];
}
function operationList(value: unknown): readonly JiraFieldOperation[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > 10 || values.some((op) => typeof op !== "string"))
    return undefined;
  return values.filter(
    (op): op is JiraFieldOperation => typeof op === "string" && OPERATIONS.has(op),
  );
}
function metadataField(value: unknown): JiraFieldMetadata | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !isJiraFieldId(raw.fieldId) ||
    !boundedText(raw.name) ||
    typeof raw.required !== "boolean"
  )
    return undefined;
  return metadataFieldDetails(raw.fieldId, raw.name, raw.required, raw);
}
function metadataFieldDetails(
  id: string,
  name: string,
  required: boolean,
  raw: Record<string, unknown>,
): JiraFieldMetadata | undefined {
  const schema = asRecord(raw.schema);
  const operations = operationList(raw.operations);
  if (schema === undefined || operations === undefined) return undefined;
  const definition = boundedReferences(fieldKind(id, schema), raw.allowedValues);
  if (definition === undefined) return undefined;
  const schemaType = declaredSchemaType(schema);
  return {
    id,
    name,
    required,
    hasDefaultValue: raw.hasDefaultValue === true,
    ...definition,
    ...(schemaType === undefined ? {} : { schemaType }),
    richText:
      id === "description" || id === "environment" || schema.custom === `${CUSTOM_PREFIX}textarea`,
    operations: supportedOperations(id, definition.kind, operations),
  };
}

function declaredSchemaType(schema: Record<string, unknown>): string | undefined {
  const type = schema.type;
  if (!boundedText(type, 64)) return undefined;
  const items = schema.items;
  return type === "array" && boundedText(items, 64) ? `array:${items}` : type;
}

export type JiraMetadataResult =
  | { readonly ok: true; readonly fields: readonly JiraFieldMetadata[] }
  | { readonly ok: false; readonly reason: "malformed-metadata" | "bounds-exceeded" };

/** Accept the paged create array, or an edit/transition map normalized by the caller. */
export function parseJiraFieldMetadata(value: unknown): JiraMetadataResult {
  const input = asArray(value);
  if (input === undefined) return { ok: false, reason: "malformed-metadata" };
  if (input.length > JIRA_METADATA_MAX_FIELDS) return { ok: false, reason: "bounds-exceeded" };
  const fields: JiraFieldMetadata[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const field = metadataField(item);
    if (field === undefined || seen.has(field.id))
      return { ok: false, reason: "malformed-metadata" };
    seen.add(field.id);
    fields.push(field);
  }
  return { ok: true, fields };
}

export type JiraFieldValidationResult =
  | {
      readonly ok: true;
      readonly fields: Readonly<Record<string, unknown>>;
      readonly update: Readonly<Record<string, readonly Record<string, string>[]>>;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "required-field"
        | "unsupported-field"
        | "invalid-field"
        | "invalid-operation"
        | "bounds-exceeded";
      readonly fieldId?: string;
    };

type ValueResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const INVALID: ValueResult = { ok: false };
function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function reference(
  field: JiraFieldMetadata,
  value: unknown,
  user: boolean,
  deployment: AtlassianConnectorDeployment,
): ValueResult {
  const raw = asRecord(value);
  const userKey = deployment === "cloud" ? "accountId" : "name";
  const key = user ? userKey : "id";
  if (raw === undefined || Object.keys(raw).length !== 1 || !boundedText(raw[key], 256))
    return INVALID;
  const ref = raw[key];
  if (field.allowedValues !== undefined && !field.allowedValues.some((entry) => entry[key] === ref))
    return INVALID;
  return { ok: true, value: { [key]: ref } };
}
function textValue(
  field: JiraFieldMetadata,
  value: unknown,
  deployment: AtlassianConnectorDeployment,
): ValueResult {
  if (typeof value !== "string" || !validFieldText(field, value)) return INVALID;
  if (deployment !== "cloud" || !field.richText) return { ok: true, value };
  const result = composePlainTextToAdf(value);
  return result.ok ? { ok: true, value: result.doc } : INVALID;
}
function validFieldText(field: JiraFieldMetadata, value: string): boolean {
  if (value.length > (field.richText ? 32768 : 255)) return false;
  if (field.required && value.trim() === "") return false;
  return field.richText || !CONTROL.test(value);
}
function numberValue(value: unknown): ValueResult {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? { ok: true, value }
    : INVALID;
}
function dateTimeValue(value: unknown): ValueResult {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(?:Z|[+-]\d{2}:?\d{2})$/u.test(
      value,
    ) ||
    !calendarDate(value.slice(0, 10))
  )
    return INVALID;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime())
    ? { ok: true, value: instant.toISOString().replace(/Z$/u, "+0000") }
    : INVALID;
}
function scalar(
  field: JiraFieldMetadata,
  value: unknown,
  deployment: AtlassianConnectorDeployment,
): ValueResult {
  switch (field.kind) {
    case "text":
      return textValue(field, value, deployment);
    case "number":
      return numberValue(value);
    case "date":
      return dateValue(value);
    case "datetime":
      return dateTimeValue(value);
    case "user":
      return reference(field, value, true, deployment);
    case "option":
      return reference(field, value, false, deployment);
    case "issue":
      return issueValue(value);
    case "opaque":
      return opaqueValue(value);
    default:
      return INVALID;
  }
}
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,254}-[1-9]\d{0,17}$/u;
/** `{ key }`, `{ id }` or a bare issue key; the result is always one canonical reference. */
function issueValue(value: unknown): ValueResult {
  if (typeof value === "string")
    return ISSUE_KEY.test(value) ? { ok: true, value: { key: value } } : INVALID;
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).length !== 1) return INVALID;
  if (typeof raw.key === "string" && ISSUE_KEY.test(raw.key))
    return { ok: true, value: { key: raw.key } };
  return typeof raw.id === "string" && /^\d{1,32}$/u.test(raw.id)
    ? { ok: true, value: { id: raw.id } }
    : INVALID;
}
function opaqueScalar(value: unknown): boolean | undefined {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4096 && !CONTROL.test(value);
  return undefined;
}
function opaqueShape(value: unknown, depth: number): boolean {
  const scalar = opaqueScalar(value);
  if (scalar !== undefined) return scalar;
  if (depth >= OPAQUE_MAX_DEPTH) return false;
  if (Array.isArray(value))
    return value.length <= MAX_VALUES && value.every((item) => opaqueShape(item, depth + 1));
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).length > 50) return false;
  return Object.entries(raw).every(
    ([key, item]) => boundedText(key, 64) && !FORBIDDEN.has(key) && opaqueShape(item, depth + 1),
  );
}
/** Bounded plain JSON, forwarded as given; Jira's validation decides what it means. */
function opaqueValue(value: unknown): ValueResult {
  if (!opaqueShape(value, 0)) return INVALID;
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength <= OPAQUE_MAX_BYTES
    ? { ok: true, value: JSON.parse(serialized) as unknown }
    : INVALID;
}
function dateValue(value: unknown): ValueResult {
  return typeof value === "string" && calendarDate(value) ? { ok: true, value } : INVALID;
}
function labelValue(value: unknown): ValueResult {
  return boundedText(value) && !/\s/u.test(value) ? { ok: true, value } : INVALID;
}
function arrayItem(
  field: JiraFieldMetadata,
  value: unknown,
  deployment: AtlassianConnectorDeployment,
): ValueResult {
  return field.kind === "strings"
    ? labelValue(value)
    : reference(field, value, field.kind === "users", deployment);
}
function arrayValue(
  field: JiraFieldMetadata,
  value: unknown,
  deployment: AtlassianConnectorDeployment,
): ValueResult {
  const input = asArray(value);
  if (input === undefined || input.length > MAX_VALUES || (field.required && input.length === 0))
    return INVALID;
  const result: unknown[] = [];
  for (const entry of input) {
    const item = arrayItem(field, entry, deployment);
    if (!item.ok) return INVALID;
    result.push(item.value);
  }
  return { ok: true, value: result };
}
export function validateJiraFieldValue(
  field: JiraFieldMetadata,
  value: unknown,
  deployment: AtlassianConnectorDeployment,
): ValueResult {
  if (value === null) return field.required ? INVALID : { ok: true, value: null };
  return ARRAY_ITEM[field.kind] === undefined
    ? scalar(field, value, deployment)
    : arrayValue(field, value, deployment);
}

type FieldFailure = Extract<JiraFieldValidationResult, { readonly ok: false }>;
type SetResult =
  { readonly ok: true; readonly fields: Readonly<Record<string, unknown>> } | FieldFailure;
type UpdateResult =
  | {
      readonly ok: true;
      readonly update: Readonly<Record<string, readonly Record<string, string>[]>>;
    }
  | FieldFailure;
function requiredEmpty(field: JiraFieldMetadata, value: unknown): boolean {
  if (!field.required) return false;
  return value === null || value === "" || (Array.isArray(value) && value.length === 0);
}
function setValue(
  field: JiraFieldMetadata | undefined,
  value: unknown,
  deployment: AtlassianConnectorDeployment,
): ValueResult | FieldFailure {
  if (field === undefined) return { ok: false, reason: "invalid-field" };
  if (field.kind === "unsupported") return { ok: false, reason: "unsupported-field" };
  if (!field.operations.includes("set")) return { ok: false, reason: "invalid-operation" };
  if (requiredEmpty(field, value)) return { ok: false, reason: "required-field" };
  return validateJiraFieldValue(field, value, deployment);
}
function validateSets(
  byId: ReadonlyMap<string, JiraFieldMetadata>,
  input: Record<string, unknown>,
  deployment: AtlassianConnectorDeployment,
): SetResult {
  const fields: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!isJiraFieldId(id)) return { ok: false, reason: "invalid-field" };
    const result = setValue(byId.get(id), value, deployment);
    if (!result.ok)
      return {
        ok: false,
        reason: "reason" in result ? result.reason : "invalid-field",
        fieldId: id,
      };
    fields[id] = result.value;
  }
  return { ok: true, fields };
}
function missingRequired(
  metadata: readonly JiraFieldMetadata[],
  fields: Readonly<Record<string, unknown>>,
  purpose: "create" | "edit" | "transition",
): FieldFailure | undefined {
  if (purpose === "edit") return undefined;
  for (const field of metadata) {
    if (
      !field.required ||
      (purpose === "create" && field.hasDefaultValue) ||
      Object.hasOwn(fields, field.id)
    )
      continue;
    return {
      ok: false,
      reason: field.kind === "unsupported" ? "unsupported-field" : "required-field",
      fieldId: field.id,
    };
  }
  return undefined;
}
function updateInput(value: unknown): JiraFieldUpdate | undefined {
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).length !== 3 || !isJiraFieldId(raw.fieldId))
    return undefined;
  if (raw.operation !== "add" && raw.operation !== "remove") return undefined;
  if (!boundedText(raw.value) || /\s/u.test(raw.value)) return undefined;
  return { fieldId: raw.fieldId, operation: raw.operation, value: raw.value };
}
function validateUpdates(
  byId: ReadonlyMap<string, JiraFieldMetadata>,
  fields: Readonly<Record<string, unknown>>,
  input: readonly unknown[],
): UpdateResult {
  const update: Record<string, Record<string, string>[]> = {};
  for (const value of input) {
    const change = updateInput(value);
    if (change === undefined) return { ok: false, reason: "invalid-operation" };
    const field = byId.get(change.fieldId);
    if (
      field?.id !== "labels" ||
      field.kind !== "strings" ||
      Object.hasOwn(fields, field.id) ||
      !field.operations.includes(change.operation)
    )
      return { ok: false, reason: "invalid-operation", fieldId: change.fieldId };
    const operations = update[field.id] ?? [];
    update[field.id] = operations;
    operations.push({ [change.operation]: change.value });
  }
  return { ok: true, update };
}

/** No caller-supplied Jira update object is forwarded. Only implemented field/verb pairs survive. */
export function validateJiraFieldChanges(
  metadata: readonly JiraFieldMetadata[],
  changes: unknown,
  purpose: "create" | "edit" | "transition",
  deployment: AtlassianConnectorDeployment,
  updates: unknown = [],
): JiraFieldValidationResult {
  const input = asRecord(changes);
  const requestedUpdates = asArray(updates);
  if (input === undefined || requestedUpdates === undefined)
    return { ok: false, reason: "invalid-field" };
  if (
    Object.keys(input).length > JIRA_METADATA_MAX_FIELDS ||
    requestedUpdates.length > JIRA_METADATA_MAX_UPDATES
  )
    return { ok: false, reason: "bounds-exceeded" };
  const byId = new Map(metadata.map((field) => [field.id, field]));
  const sets = validateSets(byId, input, deployment);
  if (!sets.ok) return sets;
  const missing = missingRequired(metadata, sets.fields, purpose);
  if (missing !== undefined) return missing;
  const changesResult = validateUpdates(byId, sets.fields, requestedUpdates);
  if (!changesResult.ok) return changesResult;
  return { ok: true, fields: sets.fields, update: changesResult.update };
}
