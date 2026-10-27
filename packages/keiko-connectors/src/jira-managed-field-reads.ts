import { projectJiraCollection } from "./jira-managed-metadata.js";
import {
  JIRA_FIELD_READ_MAX,
  type JiraFieldMetadata,
  type JiraFieldKind,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  isJiraFieldId,
  parseJiraFieldMetadata,
  projectJiraFieldReference,
  validateJiraFieldValue,
} from "./jira-field-metadata.js";

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
function valueProjection(field: JiraFieldMetadata, value: unknown): CatalogJsonObject {
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
export function jiraSelectedFieldValues(
  body: Record<string, unknown>,
  selected: readonly string[],
): readonly CatalogJsonObject[] {
  const values = asRecord(body.fields);
  return selected.map((id) => {
    const field = metadata(body, id);
    const identity = { id, name: field?.name ?? id, kind: field?.kind ?? "unsupported" };
    if (field === undefined) return { ...identity, state: "unavailable" };
    if (field.kind === "unsupported") return { ...identity, state: "unsupported" };
    if (values === undefined || !Object.hasOwn(values, id))
      return { ...identity, state: "unavailable" };
    return { ...identity, ...valueProjection(field, values[id]) };
  });
}
