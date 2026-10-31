import { projectJiraCollection } from "./jira-managed-metadata.js";
import {
  JIRA_FIELD_READ_MAX,
  type JiraFieldMetadata,
  type JiraFieldKind,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  isJiraFieldId,
  parseJiraFieldMetadata,
  projectJiraFieldReference,
  validateJiraFieldValue,
} from "./jira-field-metadata.js";

const UTF8 = new TextEncoder();
export function jiraProjectionBytes(value: CatalogJsonValue): number {
  return UTF8.encode(JSON.stringify(value)).length;
}
export function jiraProjectionTextFits(value: string): boolean {
  return UTF8.encode(value).length <= TOOL_CATALOG_LIMITS.maxStringBytes;
}

export function selectedJiraReadFields(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  const fields = asArray(value);
  if (
    fields === undefined ||
    fields.length === 0 ||
    fields.length > JIRA_FIELD_READ_MAX ||
    !fields.every(isJiraFieldId) ||
    new Set(fields).size !== fields.length
  )
    return undefined;
  return [...fields];
}
export function jiraIssueFieldsQuery(standard: string, value: unknown): string | undefined {
  const selected = selectedJiraReadFields(value);
  if (selected === undefined) return undefined;
  if (selected.length === 0) return `fields=${standard}`;
  return new URLSearchParams({
    fields: [...new Set([...standard.split(","), ...selected])].join(","),
    expand: "names,schema",
  }).toString();
}
function metadata(body: Record<string, unknown>, id: string): JiraFieldMetadata | undefined {
  const names = asRecord(body.names);
  const schema = asRecord(body.schema)?.[id];
  const result = parseJiraFieldMetadata([
    { fieldId: id, name: names?.[id] ?? id, schema, required: false, operations: [] },
  ]);
  return result.ok ? result.fields[0] : undefined;
}
function projectedReference(value: unknown, key: "name" | "id"): CatalogJsonObject | undefined {
  const candidate = projectJiraFieldReference(value);
  const identity = candidate?.[key];
  if (identity === undefined) return undefined;
  return { [key]: identity, ...(candidate?.label === undefined ? {} : { label: candidate.label }) };
}
interface ReferenceShape {
  readonly multiple: boolean;
  readonly key: "name" | "id";
}
const REFERENCE_SHAPES: Readonly<Partial<Record<JiraFieldKind, ReferenceShape>>> = {
  user: { multiple: false, key: "name" },
  users: { multiple: true, key: "name" },
  option: { multiple: false, key: "id" },
  options: { multiple: true, key: "id" },
};
function referenceValue(field: JiraFieldMetadata, value: unknown): CatalogJsonObject {
  if (value === null) return { state: "empty" };
  const shape = REFERENCE_SHAPES[field.kind];
  if (shape === undefined) return { state: "unavailable" };
  const input = shape.multiple ? asArray(value) : [value];
  const refs =
    input === undefined
      ? undefined
      : projectJiraCollection(input, 100, (raw) => projectedReference(raw, shape.key), shape.key);
  if (refs === undefined) return { state: "unavailable" };
  const identities = refs.map((ref) => ({ [shape.key]: ref[shape.key] }));
  const validated = validateJiraFieldValue(
    field,
    shape.multiple ? identities : identities[0],
    "data-center",
  );
  if (!validated.ok) return { state: "unavailable" };
  return refs.length === 0 ? { state: "empty" } : { state: "value", references: refs };
}
/** A read issue reference is projected to its key; Jira returns the full issue object. */
function issueReadValue(value: unknown): CatalogJsonObject {
  if (value === null) return { state: "empty" };
  const raw = asRecord(value);
  const key = raw?.key;
  return typeof key === "string" && key.length > 0 && key.length <= 255
    ? { state: "value", text: key }
    : { state: "unavailable" };
}
/** An opaque read value is serialized JSON text, bounded like any other text value. */
function opaqueReadValue(value: unknown): CatalogJsonObject {
  if (value === null) return { state: "empty" };
  if (Array.isArray(value) && value.length === 0) return { state: "empty" };
  const text = JSON.stringify(value);
  return typeof text === "string" && jiraProjectionTextFits(text)
    ? { state: "value", text }
    : { state: "unavailable" };
}
export function projectJiraFieldReadValue(
  field: JiraFieldMetadata,
  value: unknown,
): CatalogJsonObject {
  if (field.kind === "issue") return issueReadValue(value);
  if (field.kind === "opaque") return opaqueReadValue(value);
  return typedReadValue(field, value);
}
function typedReadValue(field: JiraFieldMetadata, value: unknown): CatalogJsonObject {
  if (Object.hasOwn(REFERENCE_SHAPES, field.kind)) return referenceValue(field, value);
  const validated = validateJiraFieldValue(field, value, "data-center");
  if (!validated.ok) return { state: "unavailable" };
  const result = validated.value;
  if (result === null || result === "") return { state: "empty" };
  if (typeof result === "string") return { state: "value", text: result };
  if (typeof result === "number") return { state: "value", number: result };
  if (Array.isArray(result) && result.every((item): item is string => typeof item === "string"))
    return result.length === 0 ? { state: "empty" } : { state: "value", strings: result };
  return { state: "unavailable" };
}
function validReadBudget(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= TOOL_CATALOG_LIMITS.maxResultBytes;
}
export function jiraSelectedFieldValues(
  body: Record<string, unknown>,
  selected: readonly string[],
  maxBytes: number = TOOL_CATALOG_LIMITS.maxResultBytes,
): readonly CatalogJsonObject[] | undefined {
  if (!validReadBudget(maxBytes)) return undefined;
  const values = asRecord(body.fields);
  const fields = selected.map((id) => metadata(body, id));
  const result: CatalogJsonObject[] = selected.map((id, index) => ({
    id,
    name: fields[index]?.name ?? id,
    kind: fields[index]?.kind ?? "unsupported",
    state: "unavailable",
  }));
  // Reserve every placeholder, including escaped/multibyte names, before admitting any value.
  let remaining = maxBytes - jiraProjectionBytes(result);
  if (remaining < 0) return undefined;
  for (const [index, placeholder] of result.entries()) {
    const field = fields[index];
    if (field === undefined) continue;
    const candidate = { ...placeholder, ...selectedValue(field, values) };
    if (typeof candidate.text === "string" && !jiraProjectionTextFits(candidate.text)) break;
    const delta = jiraProjectionBytes(candidate) - jiraProjectionBytes(placeholder);
    if (delta > remaining) break;
    result[index] = candidate;
    remaining -= delta;
  }
  return result;
}
function selectedValue(
  field: JiraFieldMetadata,
  values: Record<string, unknown> | undefined,
): CatalogJsonObject {
  if (field.kind === "unsupported") return { state: "unsupported" };
  if (values === undefined || !Object.hasOwn(values, field.id)) return { state: "unavailable" };
  return projectJiraFieldReadValue(field, values[field.id]);
}
