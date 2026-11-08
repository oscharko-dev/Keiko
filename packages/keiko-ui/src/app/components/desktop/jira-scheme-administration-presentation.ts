import {
  JIRA_OPTION_SCHEME_MUTATIONS,
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import { jiraAdministrativeReceiptContext as closed } from "./jira-administrative-receipt-context";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationRecord as record,
  jiraPresentationNativeText as nativeText,
  jiraPresentationMutationLabels,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const aliases = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values.map((name) => name.replace(/[.-]/gu, "_")));
export const JIRA_OPTION_SCHEME_WRITE_TOOLS = aliases(JIRA_OPTION_SCHEME_MUTATIONS);
export const JIRA_WORKFLOW_SCHEME_WRITE_TOOLS = aliases(JIRA_WORKFLOW_SCHEME_MUTATIONS);
export const JIRA_SCHEME_ADMINISTRATION_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_OPTION_SCHEME_WRITE_TOOLS,
  ...JIRA_WORKFLOW_SCHEME_WRITE_TOOLS,
]);
const ASSOCIATIONS: Readonly<Record<string, string>> = {
  jira_add_issue_type_scheme_projects: "add",
  jira_set_issue_type_scheme_projects: "replace",
  jira_clear_issue_type_scheme_projects: "clear",
  jira_remove_issue_type_scheme_project: "remove",
};
const NEVER = new Set([
  "jira_delete_issue_type_scheme",
  "jira_delete_priority_scheme",
  ...Object.keys(ASSOCIATIONS),
  "jira_delete_workflow_scheme",
  "jira_set_workflow_scheme_default",
  "jira_delete_workflow_scheme_default",
  "jira_set_workflow_scheme_issue_type",
  "jira_delete_workflow_scheme_issue_type",
  "jira_set_workflow_scheme_workflow",
  "jira_delete_workflow_scheme_workflow",
]);
function wholeDeletion(tool: string): boolean {
  return tool === "jira_delete_workflow_scheme" || tool === "jira_delete_workflow_scheme_draft";
}
function uniqueList(value: unknown, valid: (item: unknown) => boolean): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    !value.every(valid)
  )
    return false;
  return new Set(value).size === value.length;
}
function projectPopulation(source: Source): boolean {
  if (
    !uniqueList(source.projectIds, (id) => identity(id) !== undefined) ||
    !uniqueList(source.projectKeys, isSafeAtlassianIdentifier)
  )
    return false;
  return (
    source.projectIds.length === source.projectKeys.length &&
    new Set(source.projectKeys.map((key) => key.toUpperCase())).size === source.projectKeys.length
  );
}
function associationComplete(tool: string, source: Source): boolean {
  if (source.associationChange !== ASSOCIATIONS[tool]) return false;
  if (!projectPopulation(source) || !Array.isArray(source.projectIds)) return false;
  if (source.associationChange === "remove") return source.projectIds.length === 1;
  return source.associationChange !== "add" || source.projectIds.length > 0;
}
function optionComplete(tool: string, source: Source): boolean {
  const association = Object.hasOwn(ASSOCIATIONS, tool);
  const fields = association
    ? ["schemeId", "schemePresent", "associationChange", "projectIds", "projectKeys"]
    : ["schemeId", "schemePresent"];
  if (!closed(source, fields) || source.schemePresent !== !tool.startsWith("jira_delete_"))
    return false;
  return !association || associationComplete(tool, source);
}
function workflowFields(tool: string): readonly string[] {
  const mapping = /_(?:default|issue_type|workflow)$/u.test(tool);
  const isType = tool.endsWith("_issue_type"),
    isWorkflow = tool.endsWith("_workflow");
  const sets = tool.startsWith("jira_set_");
  return [
    "schemeId",
    "schemePresent",
    "workflowSchemeScope",
    ...(tool.includes("_draft") ? ["draftSchemeId"] : []),
    ...(mapping ? ["mappingPresent"] : []),
    ...(isType ? ["issueTypeId"] : []),
    ...(mapping && (sets || isWorkflow) ? ["workflowName"] : []),
  ];
}
function mappingPresence(tool: string, value: unknown): boolean {
  if (tool.startsWith("jira_set_") && tool.endsWith("_workflow")) return typeof value === "boolean";
  return value === tool.startsWith("jira_set_");
}
function workflowMappingComplete(tool: string, source: Source): boolean {
  const mapping = /_(?:default|issue_type|workflow)$/u.test(tool);
  const isType = tool.endsWith("_issue_type"),
    isWorkflow = tool.endsWith("_workflow");
  const sets = tool.startsWith("jira_set_");
  if (!closed(source, workflowFields(tool))) return false;
  if (!mapping) return true;
  if (!mappingPresence(tool, source.mappingPresent)) return false;
  if (isType && identity(source.issueTypeId) === undefined) return false;
  return !(sets || isWorkflow) || nativeText(source.workflowName, 255, { multiline: true });
}
function workflowComplete(tool: string, source: Source): boolean {
  const draft = tool.includes("_draft");
  if (
    source.workflowSchemeScope !== (draft ? "draft" : "scheme") ||
    source.schemePresent !== !wholeDeletion(tool)
  )
    return false;
  if (draft && identity(source.draftSchemeId) === undefined) return false;
  return workflowMappingComplete(tool, source);
}
export function jiraSchemeAdministrationIdentityComplete(tool: string, source: Source): boolean {
  if (
    !nativeText(source.userKey, 255, { multiline: true }) ||
    identity(source.schemeId) === undefined
  )
    return false;
  if (JIRA_OPTION_SCHEME_WRITE_TOOLS.has(tool)) return optionComplete(tool, source);
  return JIRA_WORKFLOW_SCHEME_WRITE_TOOLS.has(tool) && workflowComplete(tool, source);
}
/** An update can change only metadata OR base mappings. Retained call arguments decide that scope. */
export function jiraSchemeConfirmationUnavailable(tool: string, args?: unknown): boolean {
  if (NEVER.has(tool)) return true;
  if (tool !== "jira_update_workflow_scheme") return false;
  const input = record(args);
  if (
    input === undefined ||
    Object.hasOwn(input, "mappings") ||
    Object.hasOwn(input, "defaultWorkflow")
  )
    return true;
  return !Object.hasOwn(input, "name") && !Object.hasOwn(input, "description");
}
export function jiraSchemeNoopSupported(tool: string): boolean {
  if (!JIRA_SCHEME_ADMINISTRATION_TOOLS.has(tool) || tool.startsWith("jira_create_")) return false;
  return ![
    "jira_delete_issue_type_scheme",
    "jira_delete_priority_scheme",
    "jira_delete_workflow_scheme",
    "jira_delete_workflow_scheme_draft",
  ].includes(tool);
}
function outcome(tool: string, source: Source, args: unknown): WidgetMessageKey[] {
  const complete = jiraSchemeAdministrationIdentityComplete(tool, source);
  if (!complete) return ["chat.jira.savedConfiguration.identityUnknown"];
  if (source.outcome === "rejected" && jiraSchemeNoopSupported(tool))
    return jiraPresentationMutationLabels(source, true);
  const observation = jiraSchemeNoopSupported(tool) ? source : { ...source, unchanged: false };
  return jiraSchemeConfirmationUnavailable(tool, args)
    ? ["chat.jira.savedConfiguration.unconfirmed"]
    : jiraPresentationMutationLabels(observation, true);
}
function projectFacts(source: Source): JiraAgileDetails["facts"] {
  const ids = source.projectIds,
    keys = source.projectKeys;
  if (!projectPopulation(source) || !Array.isArray(ids) || !Array.isArray(keys)) return [];
  return [
    { label: "chat.jira.schemeWrite.projectTargetCount", value: String(ids.length) },
    ...ids.flatMap((id: unknown, index: number) => [
      ...fact("chat.jira.fact.projectId", identity(id)),
      ...fact("chat.jira.fact.projectKey", keys[index]),
    ]),
  ];
}
export function jiraSchemeAdministrationDetails(
  tool: string,
  source: Source,
  args?: unknown,
): readonly JiraAgileDetails[] {
  if (!JIRA_SCHEME_ADMINISTRATION_TOOLS.has(tool)) return [];
  const labels: WidgetMessageKey[] = [
    ...outcome(tool, source, args),
    "chat.jira.schemeWrite.configurationOnly",
  ];
  if (JIRA_WORKFLOW_SCHEME_WRITE_TOOLS.has(tool))
    labels.push(
      source.workflowSchemeScope === "draft"
        ? "chat.jira.schemeWrite.draftOnly"
        : "chat.jira.schemeWrite.baseOnly",
    );
  if (Object.hasOwn(ASSOCIATIONS, tool))
    labels.push("chat.jira.schemeWrite.associationConsequences");
  if (source.schemePresent === false) labels.push("chat.jira.accessWrite.requestedAbsent");
  if (source.schemePresent === true) labels.push("chat.jira.accessWrite.requestedPresent");
  if (typeof source.mappingPresent === "boolean")
    labels.push(
      source.mappingPresent
        ? "chat.jira.schemeWrite.mappingRequested"
        : "chat.jira.schemeWrite.mappingRemovalRequested",
    );
  return [
    {
      labels,
      facts: [
        ...fact("chat.jira.access.schemeId", identity(source.schemeId)),
        ...fact("chat.jira.schemeWrite.draftId", identity(source.draftSchemeId)),
        ...fact("chat.jira.fact.userKey", source.userKey),
        ...fact("chat.jira.fact.issueTypeId", identity(source.issueTypeId)),
        ...fact("chat.jira.fact.workflow", source.workflowName),
        ...projectFacts(source),
      ],
    },
  ];
}
