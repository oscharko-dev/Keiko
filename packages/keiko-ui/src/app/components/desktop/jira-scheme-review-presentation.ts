import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraPresentationFact as fact, jiraPresentationIdentity as identity, jiraPresentationRecord as record,
  jiraPresentationNativeText as nativeText, type JiraPresentationSource as Source } from "./jira-presentation-values";
import { jiraPropertyValueDetails } from "./jira-property-presentation";

type Kind = "issue-type" | "priority" | "workflow";
function idList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1000 && value.every((id: unknown) => identity(id) !== undefined) && new Set(value).size === value.length;
}
function mappings(value: unknown): value is Source[] {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const ids = new Set<string>();
  for (const item of value) {
    const row = record(item);
    const id = identity(row?.issueTypeId);
    if (id === undefined || row === undefined || !nativeText(row.workflow, 255) || ids.has(id)) return false;
    if (Object.keys(row).some((key) => key !== "issueTypeId" && key !== "workflow")) return false;
    ids.add(id);
  }
  return true;
}
function nullableText(value: unknown): boolean { return value === null || nativeText(value, 32768, { empty: true, multiline: true }); }
function nullableWorkflow(value: unknown): boolean { return value === null || nativeText(value, 255); }
function commonSnapshot(source: Source): Source | undefined {
  const snapshot = record(source.reviewSnapshot);
  if (source.reviewSnapshotAvailable === false || snapshot === undefined) return undefined;
  if (identity(snapshot.id) === undefined || snapshot.id !== source.id || !nativeText(snapshot.name, 255)) return undefined;
  if (source.name !== undefined && source.name !== snapshot.name) return undefined;
  if (!nullableText(snapshot.description)) return undefined;
  return source.description === undefined || source.description === snapshot.description ? snapshot : undefined;
}
function optionSnapshot(kind: Kind, snapshot: Source): boolean {
  const ids = kind === "issue-type" ? snapshot.issueTypeIds : snapshot.optionIds;
  const selected = kind === "issue-type" ? snapshot.defaultIssueTypeId : snapshot.defaultOptionId;
  if (!idList(ids) || !(selected === null || identity(selected) !== undefined)) return false;
  if (selected !== null && !ids.includes(String(selected))) return false;
  return kind !== "priority" || typeof snapshot.defaultScheme === "boolean";
}
function workflowSnapshot(snapshot: Source): boolean {
  if (typeof snapshot.draft !== "boolean" || !nullableWorkflow(snapshot.defaultWorkflow) || !mappings(snapshot.mappings)) return false;
  if (!snapshot.draft) return optionalOriginals(snapshot);
  return nullableWorkflow(snapshot.originalDefaultWorkflow) && mappings(snapshot.originalMappings);
}
function optionalOriginals(snapshot: Source): boolean {
  return (!Object.hasOwn(snapshot, "originalDefaultWorkflow") || nullableWorkflow(snapshot.originalDefaultWorkflow)) &&
    (!Object.hasOwn(snapshot, "originalMappings") || mappings(snapshot.originalMappings));
}
function fields(kind: Kind): readonly string[] {
  const common = ["id", "name", "description"];
  if (kind === "issue-type") return [...common, "issueTypeIds", "defaultIssueTypeId"];
  if (kind === "priority") return [...common, "optionIds", "defaultOptionId", "defaultScheme"];
  return [...common, "draft", "defaultWorkflow", "mappings", "originalDefaultWorkflow", "originalMappings"];
}
function snapshotFor(kind: Kind, source: Source): Source | undefined {
  const snapshot = commonSnapshot(source);
  if (snapshot === undefined || Object.keys(snapshot).some((key) => !fields(kind).includes(key))) return undefined;
  if (kind !== "workflow") return optionSnapshot(kind, snapshot) ? snapshot : undefined;
  if (source.draft !== undefined && source.draft !== snapshot.draft) return undefined;
  return workflowSnapshot(snapshot) ? snapshot : undefined;
}
function nullableFacts(label: WidgetMessageKey, value: unknown): JiraAgileDetails {
  if (value === null) return { facts: [], labels: [label, "chat.jira.structural.nativeNotProvided"] };
  if (value === "") return { facts: [], labels: [label, "chat.jira.propertyMutation.emptyText"] };
  if (typeof value !== "string") return { facts: [], labels: [] };
  const body = value.trim().length > 0 ? value : jiraPropertyValueDetails({ kind: "string", path: "", textValue: value }).body ?? value;
  return { facts: [{ label, value: body }], labels: [] };
}
function optionFacts(kind: Kind, snapshot: Source): JiraAgileDetails {
  const ids = kind === "issue-type" ? snapshot.issueTypeIds : snapshot.optionIds;
  const selected = kind === "issue-type" ? snapshot.defaultIssueTypeId : snapshot.defaultOptionId;
  const defaultFact = nullableFacts(kind === "issue-type" ? "chat.jira.schemeWrite.defaultIssueType" : "chat.jira.association.defaultPriorityId", selected);
  const label = kind === "issue-type" ? "chat.jira.schemeWrite.issueTypeOrder" : "chat.jira.schemeWrite.priorityOrder";
  const facts: JiraOutcomeFact[] = idList(ids) ? ids.map((id, index) => ({ label, value: `${String(index + 1)}: ${id}` })) : [];
  if (typeof snapshot.defaultScheme === "boolean") facts.push({ label: "chat.jira.schemeWrite.defaultScheme", value: String(snapshot.defaultScheme) });
  return { facts: [...facts, ...defaultFact.facts], labels: defaultFact.labels };
}
function mappingFacts(value: unknown, original: boolean): JiraOutcomeFact[] {
  if (!mappings(value)) return [];
  return [{ label: original ? "chat.jira.schemeWrite.originalMappings" : "chat.jira.schemeWrite.mappingCount", value: String(value.length) },
    ...value.map((row) => ({ label: original ? "chat.jira.schemeWrite.originalMapping" : "chat.jira.schemeWrite.mapping", value: `${String(row.issueTypeId)} → ${String(row.workflow)}` } satisfies JiraOutcomeFact))];
}
function workflowFacts(snapshot: Source): JiraAgileDetails {
  const current = nullableFacts("chat.jira.schemeWrite.configuredDefault", snapshot.defaultWorkflow);
  const original = nullableFacts("chat.jira.fact.originalDefaultWorkflow", snapshot.originalDefaultWorkflow);
  return { facts: [...current.facts, ...original.facts, ...mappingFacts(snapshot.mappings, false), ...mappingFacts(snapshot.originalMappings, true)],
    labels: [...current.labels, ...original.labels, snapshot.draft === true ? "chat.jira.schemeWrite.draftOnly" : "chat.jira.schemeWrite.baseOnly", "chat.jira.schemeWrite.configuredNotEffective"] };
}
/** Display the same complete observed review form; absence never manufactures an editable snapshot. */
export function jiraSchemeReviewDetails(kind: Kind, source: Source): JiraAgileDetails {
  if (identity(source.id) === undefined) return { facts: [], labels: [] };
  const snapshot = snapshotFor(kind, source);
  if (snapshot === undefined) return { facts: [], labels: ["chat.jira.schemeWrite.reviewUnavailable"] };
  const description = nullableFacts("chat.jira.structural.nativeDescription", snapshot.description);
  const values = kind === "workflow" ? workflowFacts(snapshot) : optionFacts(kind, snapshot);
  return { facts: [...fact("chat.jira.access.schemeId", snapshot.id), ...description.facts, ...values.facts],
    labels: ["chat.jira.schemeWrite.reviewAvailable", ...description.labels, ...values.labels] };
}
