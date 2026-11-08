import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraCoreMetadataProjection } from "./jira-core-metadata-values.js";
import { jiraFieldDirectoryProjection } from "./jira-managed-field-directory.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { gateJiraSchemaRuleImpact, type JiraIssueTemplateSource, type JiraSchemaRuleImpact } from "./jira-managed-template-gate.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import type { FieldInput, IssueTypeInput, LinkTypeInput, SchemaInput } from "./jira-schema-mutation-input.js";
import { SCHEMA_MALFORMED, sameSchemaValue, schemaFieldSnapshot, schemaIssueTypeSnapshot, schemaLinkTypeSnapshot,
  schemaList, schemaRefusal, schemaTerminologySnapshot, type FieldSnapshot, type IssueTypeSnapshot,
  type LinkTypeSnapshot, type SchemaFailure, type SchemaObservation, type TerminologySnapshot } from "./jira-schema-mutation-values.js";

export async function readSchemaList<T extends object>(request: JiraMutationRequest, path: string, wrapper: string | undefined, project: (raw: unknown) => T | undefined, identity: (item: T) => string): Promise<SchemaObservation<readonly T[]>> {
  const response = await request(path, "GET", undefined, wrapper === undefined ? "json-array" : "json");
  if (!response.ok) return dispatchFailure(response);
  const raw = wrapper === undefined ? response.items : response.body?.[wrapper];
  if (response.status !== 200 || !Array.isArray(raw)) return SCHEMA_MALFORMED;
  if (raw.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const items = schemaList(raw, project, identity);
  return items === undefined ? SCHEMA_MALFORMED : { ok: true, value: items };
}
export async function readSchemaType(request: JiraMutationRequest, id: string): Promise<SchemaObservation<IssueTypeSnapshot>> {
  const response = await request(`issuetype/${id}`);
  if (!response.ok) return dispatchFailure(response);
  const observed = response.status === 200 ? schemaIssueTypeSnapshot(response.body) : undefined;
  return observed?.id === id ? { ok: true, value: observed } : SCHEMA_MALFORMED;
}
export async function readSchemaLink(request: JiraMutationRequest, id: string): Promise<SchemaObservation<LinkTypeSnapshot>> {
  const response = await request(`issueLinkType/${id}`);
  if (!response.ok) return dispatchFailure(response);
  const observed = response.status === 200 ? schemaLinkTypeSnapshot(response.body) : undefined;
  return observed?.id === id ? { ok: true, value: observed } : SCHEMA_MALFORMED;
}
export function readSchemaLinks(request: JiraMutationRequest): Promise<SchemaObservation<readonly LinkTypeSnapshot[]>> {
  return readSchemaList(request, "issueLinkType", "issueLinkTypes", schemaLinkTypeSnapshot, (item) => item.id);
}
export async function readSchemaFields(request: JiraMutationRequest): Promise<SchemaObservation<readonly FieldSnapshot[]>> {
  const response = await request("field", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return SCHEMA_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  // Validate every field first. System fields are deliberately outside the deletion selection.
  const all = schemaList(response.items, jiraFieldDirectoryProjection, (item) => String(item.id));
  if (all === undefined) return SCHEMA_MALFORMED;
  const custom = schemaList(all.filter((item) => item.custom === true), schemaFieldSnapshot, (item) => item.id);
  return custom === undefined ? SCHEMA_MALFORMED : { ok: true, value: custom };
}
export function readSchemaTerminology(request: JiraMutationRequest): Promise<SchemaObservation<readonly TerminologySnapshot[]>> {
  return readSchemaList(request, "terminology/entries", undefined, schemaTerminologySnapshot, (item) => item.originalName.toLowerCase());
}
export async function readSchemaCreationIds(request: JiraMutationRequest, input: SchemaInput): Promise<SchemaObservation<readonly string[]>> {
  if (input.family === "terminology" || input.kind !== "create") return { ok: true, value: [] };
  if (input.family === "field") {
    const observed = await readSchemaFields(request);
    return observed.ok ? { ok: true, value: observed.value.map((field) => field.id) } : observed;
  }
  if (input.family === "link-type") {
    const observed = await readSchemaLinks(request);
    if (!observed.ok) return observed;
    if (observed.value.some((item) => item.name === input.target.name)) return schemaRefusal("The reviewed link-type name already exists. Review the exact existing ID instead of attempting creation.", "conflict");
    return { ok: true, value: observed.value.map((item) => item.id) };
  }
  const observed = await readSchemaList(request, "issuetype", undefined,
    (raw) => jiraCoreMetadataProjection("issue-type", raw), (item) => String(item.id));
  if (!observed.ok) return observed;
  if (observed.value.some((item) => item.name === input.name)) return schemaRefusal("The reviewed issue-type name already exists. Review the existing ID instead of attempting creation.", "conflict");
  return { ok: true, value: observed.value.map((item) => String(item.id)) };
}
function changed(): SchemaFailure { return schemaRefusal("The exact independently read schema metadata differs from the reviewed snapshot. Review the current configuration before changing it.", "conflict"); }
async function bindAlternative(request: JiraMutationRequest, input: Extract<IssueTypeInput, { kind: "delete" }>): Promise<SchemaFailure | undefined> {
  if (input.alternative === null) return undefined;
  const alternative = await readSchemaType(request, input.alternative.id);
  if (!alternative.ok) return alternative;
  if (!sameSchemaValue(alternative.value, input.alternative)) return changed();
  const alternatives = await readSchemaList(request, `issuetype/${input.expected.id}/alternatives`, undefined,
    (raw) => jiraCoreMetadataProjection("issue-type", raw), (item) => String(item.id));
  if (!alternatives.ok) return alternatives;
  return alternatives.value.some((item) => item.id === input.alternative?.id) ? undefined
    : schemaRefusal("The reviewed replacement is not in Jira's native compatible migration alternatives. Do not infer workflow, field or screen compatibility.");
}
async function bindType(request: JiraMutationRequest, input: IssueTypeInput): Promise<SchemaFailure | undefined> {
  if (input.kind === "create") return undefined;
  const current = await readSchemaType(request, input.expected.id);
  if (!current.ok) return current;
  if (!sameSchemaValue(current.value, input.expected)) return changed();
  return input.kind === "delete" ? bindAlternative(request, input) : undefined;
}
async function bindLink(request: JiraMutationRequest, input: LinkTypeInput): Promise<SchemaFailure | undefined> {
  if (input.kind === "create") return undefined;
  if (input.kind === "order" || input.kind === "move") {
    const current = await readSchemaLinks(request);
    return !current.ok ? current : sameSchemaValue(current.value, input.expectedTypes) ? undefined : changed();
  }
  const current = await readSchemaLink(request, input.expected.id);
  return !current.ok ? current : sameSchemaValue(current.value, input.expected) ? undefined : changed();
}
async function bindFieldContexts(request: JiraMutationRequest, input: Extract<FieldInput, { kind: "create" }>): Promise<SchemaFailure | undefined> {
  for (const project of input.projectIds) { const result = await readJiraBoundProject(request, project); if (!result.ok) return result; }
  for (const id of input.issueTypeIds) { const result = await readSchemaType(request, id); if (!result.ok) return result; }
  return undefined;
}
async function bindField(request: JiraMutationRequest, input: FieldInput): Promise<SchemaFailure | undefined> {
  if (input.kind === "create") return bindFieldContexts(request, input);
  const current = await readSchemaFields(request);
  if (!current.ok) return current;
  return input.expectedFields.every((expected) => current.value.some((field) => sameSchemaValue(field, expected))) ? undefined : changed();
}
export async function bindSchemaConfiguration(request: JiraMutationRequest, input: SchemaInput): Promise<SchemaFailure | undefined> {
  if (input.family === "issue-type") return bindType(request, input);
  if (input.family === "link-type") return bindLink(request, input);
  if (input.family === "field") return bindField(request, input);
  const current = await readSchemaTerminology(request);
  if (!current.ok) return current;
  return sameTerminology(current.value, input.expectedEntries) ? undefined : changed();
}
export function sameTerminology(left: readonly TerminologySnapshot[], right: readonly TerminologySnapshot[]): boolean {
  return left.length === right.length && left.every((item) => right.some((other) => sameSchemaValue(item, other)));
}
function typeImpact(input: IssueTypeInput): JiraSchemaRuleImpact | undefined {
  if (input.kind === "create") return undefined;
  if (input.kind === "delete") return { kind: "issue-type", types: [input.expected, ...(input.alternative === null ? [] : [input.alternative])] };
  return input.target.name === undefined || input.target.name === input.expected.name ? undefined
    : { kind: "issue-type", types: [input.expected, { id: input.expected.id, name: input.target.name }] };
}
function impact(input: SchemaInput): JiraSchemaRuleImpact | undefined {
  if (input.family === "issue-type") return typeImpact(input);
  if (input.family === "field") return input.kind === "delete" ? { kind: "custom-fields", fields: input.expectedFields } : undefined;
  return input.family === "link-type" ? linkImpact(input) : undefined;
}
function linkImpact(input: LinkTypeInput): JiraSchemaRuleImpact | undefined {
  if (input.kind !== "delete" && input.kind !== "update") return undefined;
  if (input.kind === "update" && sameSchemaValue({ ...input.target, id: input.expected.id }, input.expected)) return undefined;
  return { kind: "link-type", names: [input.expected.name, input.expected.inward, input.expected.outward] };
}
export async function admitSchemaMutation(request: JiraMutationRequest, input: SchemaInput, templates?: JiraIssueTemplateSource): Promise<SchemaFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  const bound = await bindSchemaConfiguration(request, input);
  if (bound !== undefined) return bound;
  const affected = impact(input);
  if (affected === undefined) return undefined;
  const gate = await gateJiraSchemaRuleImpact({ request, source: templates, impact: affected });
  return gate.ok ? undefined : { ...gate, detail: { messages: ["Saved formal rules govern the affected native field, issue-type selection or parent link. The native bulk/configuration operation cannot prove every hidden issue's post-state. Migrate affected issues with governed per-issue changes and review the saved rules before retrying; prose is not an enforcement record."] } };
}
