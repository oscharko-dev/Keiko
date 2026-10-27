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

const MAX_FIELDS = 500;
const MAX_VALUES = 100;
const FIELD_ID = /^(?:[a-zA-Z][a-zA-Z0-9]*|customfield_\d{1,16})$/u;
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
function isFieldId(value: unknown): value is string {
  return boundedText(value, 64) && FIELD_ID.test(value) && !FORBIDDEN.has(value);
}
function declaredKind(id: string, schema: Record<string, unknown>): JiraFieldKind | undefined {
  if (schema.custom === undefined)
    return schema.system === id && Object.hasOwn(STANDARD, id) ? STANDARD[id] : undefined;
  if (
    typeof schema.custom !== "string" ||
    !schema.custom.startsWith(CUSTOM_PREFIX) ||
    !id.startsWith("customfield_")
  )
    return undefined;
  const custom = schema.custom.slice(CUSTOM_PREFIX.length);
  return Object.hasOwn(CUSTOM, custom) ? CUSTOM[custom] : undefined;
}
function expectedItem(id: string, item: string): string {
  if (id === "components") return "component";
  return id === "versions" || id === "fixVersions" ? "version" : item;
}
function fieldKind(id: string, schema: Record<string, unknown>): JiraFieldKind {
  const kind = declaredKind(id, schema);
  if (kind === undefined) return "unsupported";
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
function referenceCandidate(value: unknown): JiraFieldReference | undefined {
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
    const candidate = referenceCandidate(value);
    if (candidate === undefined) return undefined;
    result.push(candidate);
  }
  return result;
}
function boundedReferences(
  kind: JiraFieldKind,
  value: unknown,
): Pick<JiraFieldMetadata, "kind" | "allowedValues"> | undefined {
  if (kind === "unsupported" || value === undefined) return { kind };
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
    !isFieldId(raw.fieldId) ||
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
  return {
    id,
    name,
    required,
    hasDefaultValue: raw.hasDefaultValue === true,
    ...definition,
    richText:
      id === "description" || id === "environment" || schema.custom === `${CUSTOM_PREFIX}textarea`,
    operations: supportedOperations(id, definition.kind, operations),
  };
}

export type JiraMetadataResult =
  | { readonly ok: true; readonly fields: readonly JiraFieldMetadata[] }
  | { readonly ok: false; readonly reason: "malformed-metadata" | "bounds-exceeded" };

/** Accept the paged create array, or an edit/transition map normalized by the caller. */
export function parseJiraFieldMetadata(value: unknown): JiraMetadataResult {
  const input = asArray(value);
  if (input === undefined) return { ok: false, reason: "malformed-metadata" };
  if (input.length > MAX_FIELDS) return { ok: false, reason: "bounds-exceeded" };
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
  const key = user ? (deployment === "cloud" ? "accountId" : "name") : "id";
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
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
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
    default:
      return INVALID;
  }
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
function fieldValue(
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
  return fieldValue(field, value, deployment);
}
function validateSets(
  byId: ReadonlyMap<string, JiraFieldMetadata>,
  input: Record<string, unknown>,
  deployment: AtlassianConnectorDeployment,
): SetResult {
  const fields: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!isFieldId(id)) return { ok: false, reason: "invalid-field" };
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
  if (raw === undefined || Object.keys(raw).length !== 3 || !isFieldId(raw.fieldId))
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
    (update[field.id] ??= []).push({ [change.operation]: change.value });
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
  if (Object.keys(input).length > MAX_FIELDS || requestedUpdates.length > 50)
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
