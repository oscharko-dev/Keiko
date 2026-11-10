import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { DEFAULT_ATLASSIAN_SYNC_BOUNDS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { mapWithConcurrency } from "@oscharko-dev/keiko-contracts/runtime/bounded-concurrency";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
  type JiraIssueTemplateSet,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
import type { JiraAgileRequests } from "./jira-agile-request.js";
import type { AgileMutationInput } from "./jira-agile-inputs.js";
import { agileId, agileIssueKey, agileSprint, agileText } from "./jira-agile-projection.js";
import { AGILE_MALFORMED } from "./jira-agile-confirmation.js";

// Stable plugin identities, not localized or user-renamed field names (Atlassian DC constants).
const FIELD_TYPES: Readonly<Record<string, string>> = {
  sprint: "com.pyxis.greenhopper.jira:gh-sprint",
  epic: "com.pyxis.greenhopper.jira:gh-epic-link",
  name: "com.pyxis.greenhopper.jira:gh-epic-label",
  done: "com.pyxis.greenhopper.jira:gh-epic-status",
  color: "com.pyxis.greenhopper.jira:gh-epic-color",
};
const OK = { ok: true } as const;
const UNRESOLVED: JiraTemplateGateResult = {
  ok: false,
  reason: "field-validation",
  violations: [{ ruleId: "template-unreadable", subject: "Agile field mapping", template: "*" }],
};
interface ResolvedFields {
  readonly metadata: readonly JiraFieldMetadata[];
  readonly byNative: ReadonlyMap<string, string>;
}
function resolvedField(items: readonly unknown[], key: string): JiraFieldMetadata | undefined {
  const matches = items
    .map(asRecord)
    .filter((field) => asRecord(field?.schema)?.custom === FIELD_TYPES[key]);
  const field = matches.length === 1 ? matches[0] : undefined;
  if (
    field === undefined ||
    typeof field.id !== "string" ||
    !/^customfield_\d{1,32}$/u.test(field.id) ||
    !agileText(field.name)
  )
    return undefined;
  return {
    id: field.id,
    name: field.name,
    kind: "unsupported",
    required: false,
    hasDefaultValue: false,
    richText: false,
    operations: [],
  };
}
async function resolveFields(
  requests: JiraAgileRequests,
  keys: readonly string[],
): Promise<ResolvedFields | undefined> {
  if (keys.length === 0) return { metadata: [], byNative: new Map() };
  const response = await requests.issue("field", "GET", undefined, "json-array");
  if (!response.ok || response.items === undefined || response.items.length > 5000)
    return undefined;
  const metadata: JiraFieldMetadata[] = [];
  const byNative = new Map<string, string>();
  for (const key of keys) {
    const field = resolvedField(response.items, key);
    if (field === undefined) return undefined;
    byNative.set(key, field.id);
    metadata.push(field);
  }
  return { metadata, byNative };
}
async function closedSprintHistory(
  requests: JiraAgileRequests,
  issueKey: string,
): Promise<readonly CatalogJsonObject[] | undefined> {
  const response = await requests.agile(
    `issue/${encodeURIComponent(issueKey)}?fields=closedSprints`,
  );
  if (
    !response.ok ||
    response.status !== 200 ||
    response.body?.key !== issueKey ||
    agileId(response.body.id) === undefined
  )
    return undefined;
  return closedSprints(asRecord(response.body.fields));
}
function closedSprints(
  fields: Record<string, unknown> | undefined,
): readonly CatalogJsonObject[] | undefined {
  if (fields === undefined || !Object.hasOwn(fields, "closedSprints")) return undefined;
  if (fields.closedSprints === null) return [];
  const raw = asArray(fields.closedSprints);
  if (raw === undefined || raw.length > 1000) return undefined;
  const sprints = raw.map(agileSprint);
  if (sprints.some((sprint) => sprint?.state !== "closed")) return undefined;
  return sprints.filter((sprint) => sprint !== undefined);
}
function epicChanges(
  input: AgileMutationInput,
  resolved: ResolvedFields,
): Readonly<Record<string, unknown>> | undefined {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.body)) {
    const fieldId = key === "summary" ? "summary" : resolved.byNative.get(key);
    if (fieldId === undefined) return undefined;
    fields[fieldId] = value;
  }
  return fields;
}
function nativeKeys(input: AgileMutationInput): readonly string[] {
  if (input.operation === "jira.epic-update")
    return Object.keys(input.body).filter((key) => key !== "summary");
  return [input.operation === "jira.epic-move-issues" ? "epic" : "sprint"];
}
async function plannedFields(
  requests: JiraAgileRequests,
  input: AgileMutationInput,
  target: CatalogJsonObject | null,
  issueKey: string,
  resolved: ResolvedFields,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (input.operation === "jira.epic-update") return epicChanges(input, resolved);
  const epic = input.operation === "jira.epic-move-issues";
  const fieldId = resolved.byNative.get(epic ? "epic" : "sprint");
  if (fieldId === undefined) return undefined;
  if (epic)
    return target === null || !agileIssueKey(target.key) ? undefined : { [fieldId]: target.key };
  const history = await closedSprintHistory(requests, issueKey);
  if (history === undefined) return undefined;
  // Semantic post-state for the shared presence/parent predicates; never parse Sprint.toString().
  return { [fieldId]: target === null ? history : [...history, target] };
}
function needsAdmission(set: JiraIssueTemplateSet): boolean {
  return (
    set.unreadable > 0 ||
    set.templates.some((template) =>
      template.activations.some((activation) => activation.kind === "edit"),
    )
  );
}
function issueTargets(
  input: AgileMutationInput,
  target: CatalogJsonObject | null,
): readonly string[] {
  return input.issues ?? (agileIssueKey(target?.key) ? [target.key] : []);
}
async function gateIssue(
  requests: JiraAgileRequests,
  set: JiraIssueTemplateSet,
  input: AgileMutationInput,
  target: CatalogJsonObject | null,
  issueKey: string,
  resolved: ResolvedFields,
): Promise<JiraTemplateGateResult> {
  const fields =
    set.unreadable > 0 ? {} : await plannedFields(requests, input, target, issueKey, resolved);
  if (fields === undefined) return UNRESOLVED;
  return gateJiraMutationByTemplates({
    request: requests.issue,
    source: () => set,
    operation: "edit",
    metadata: resolved.metadata,
    validated: { fields, update: {} },
    target: { issueKey },
  });
}
/** Every issue in one native batch is admitted before its single POST; no alternate template engine. */
export async function gateJiraAgileIssueChange(
  requests: JiraAgileRequests,
  source: JiraIssueTemplateSource | undefined,
  input: AgileMutationInput,
  target: CatalogJsonObject | null,
): Promise<JiraTemplateGateResult> {
  const set = source?.();
  if (set === undefined) return OK;
  if (!needsAdmission(set)) return OK;
  const keys = issueTargets(input, target);
  if (keys.length === 0) return AGILE_MALFORMED;
  const resolved =
    set.unreadable > 0
      ? { metadata: [], byNative: new Map<string, string>() }
      : await resolveFields(requests, nativeKeys(input));
  if (resolved === undefined) return UNRESOLVED;
  const gates = await mapWithConcurrency(
    keys,
    DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxConcurrency,
    (issueKey) => gateIssue(requests, set, input, target, issueKey, resolved),
    requests.signal,
  );
  return gates.find((gate) => !gate.ok) ?? OK;
}
