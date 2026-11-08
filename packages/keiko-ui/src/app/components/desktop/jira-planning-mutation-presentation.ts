import {
  JIRA_AGILE_PLANNING_MUTATIONS,
  JIRA_VERSION_REMOTE_LINK_MUTATIONS,
  JIRA_PROJECT_CATEGORY_MUTATIONS,
  JIRA_FIELD_ID_PATTERN,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationText as text,
  jiraPresentationMutationLabels as mutationLabels,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const aliases = (names: readonly string[]): ReadonlySet<string> =>
  new Set(names.map((name) => name.replace(/[.-]/gu, "_")));
export const JIRA_AGILE_PLANNING_TOOLS = aliases(JIRA_AGILE_PLANNING_MUTATIONS);
export const JIRA_VERSION_LINK_WRITE_TOOLS = aliases(JIRA_VERSION_REMOTE_LINK_MUTATIONS);
export const JIRA_CATEGORY_WRITE_TOOLS = aliases(JIRA_PROJECT_CATEGORY_MUTATIONS);
export const JIRA_PLANNING_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_AGILE_PLANNING_TOOLS,
  ...JIRA_VERSION_LINK_WRITE_TOOLS,
  ...JIRA_CATEGORY_WRITE_TOOLS,
]);
const UNCONFIRMED = new Set(["jira_rank_epic", "jira_rank_issues", "jira_delete_project_category"]);
const FIELD = new RegExp(JIRA_FIELD_ID_PATTERN, "u");
export const jiraPlanningConfirmationUnavailable = (tool: string): boolean => UNCONFIRMED.has(tool);
function safeId(value: unknown): boolean {
  return identity(value) !== undefined && Number.isSafeInteger(Number(value));
}
function fieldId(value: unknown): boolean {
  return typeof value === "string" && value.length <= 64 && FIELD.test(value);
}
function strings(
  value: unknown,
  valid: (value: unknown) => boolean,
  empty = false,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    (empty || value.length > 0) &&
    value.every((entry: unknown) => typeof entry === "string" && valid(entry)) &&
    new Set(value).size === value.length
  );
}
function selectedIssues(source: Source): boolean {
  return (
    strings(source.issueIds, (value) => identity(value) !== undefined) &&
    strings(source.issueKeys, isSafeAtlassianIdentifier) &&
    source.issueIds.length === source.issueKeys.length &&
    source.issueIds.length <= 50
  );
}
function rankField(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith("customfield_") &&
    safeId(value.slice("customfield_".length))
  );
}
function rankSelection(tool: string, source: Source): boolean {
  if (
    !selectedIssues(source) ||
    !Array.isArray(source.issueIds) ||
    !Array.isArray(source.issueKeys)
  )
    return false;
  return (
    (tool !== "jira_rank_epic" || source.issueIds.length === 1) &&
    !source.issueIds.includes(source.anchorIssueId) &&
    !source.issueKeys.includes(source.anchorIssueKey)
  );
}
function rankComplete(tool: string, source: Source): boolean {
  if (!rankSelection(tool, source) || !safeId(source.boardId) || !rankField(source.fieldId))
    return false;
  return (
    identity(source.anchorIssueId) !== undefined &&
    isSafeAtlassianIdentifier(source.anchorIssueKey) &&
    (source.rankDirection === "before" || source.rankDirection === "after")
  );
}
function estimationComplete(source: Source): boolean {
  return (
    safeId(source.boardId) &&
    fieldId(source.fieldId) &&
    identity(source.issueId) !== undefined &&
    isSafeAtlassianIdentifier(source.issueKey) &&
    estimateValue(source.estimationValue) &&
    estimateUnit(source)
  );
}
function estimateUnit(source: Source): boolean {
  if (source.fieldId === "timeoriginalestimate")
    return source.estimationUnit === "seconds" && Number.isSafeInteger(source.estimationValue);
  return source.estimationUnit === "board-number";
}
function estimateValue(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
function versionComplete(tool: string, source: Source): boolean {
  if (
    identity(source.versionId) === undefined ||
    identity(source.projectId) === undefined ||
    !isSafeAtlassianIdentifier(source.projectKey)
  )
    return false;
  const deleting = tool.startsWith("jira_delete_");
  if (source.linkPresent !== !deleting) return false;
  return tool === "jira_delete_version_remote_links"
    ? source.globalId === undefined &&
        strings(source.globalIds, (value) => jiraVersionReviewGlobalId(value, false), true)
    : source.globalIds === undefined &&
        jiraVersionReviewGlobalId(source.globalId, tool !== "jira_upsert_version_remote_link");
}
/** Same native selector boundary in display-only form; it never builds or follows a URL. */
export function jiraVersionReviewGlobalId(value: unknown, path: boolean): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2048 ||
    /[\p{Cc}\p{Surrogate}]/u.test(value)
  )
    return false;
  return !path || (value !== "." && value !== ".." && !/[/\\%]/u.test(value));
}
export function jiraPlanningIdentityComplete(tool: string, source: Source): boolean {
  if (!actorKey(source.userKey)) return false;
  if (JIRA_VERSION_LINK_WRITE_TOOLS.has(tool)) return versionComplete(tool, source);
  if (JIRA_CATEGORY_WRITE_TOOLS.has(tool))
    return (
      identity(source.categoryId) !== undefined &&
      source.categoryPresent === (tool !== "jira_delete_project_category")
    );
  if (tool === "jira_set_issue_estimation") return estimationComplete(source);
  if (tool === "jira_epic_remove_issues")
    return selectedIssues(source) && source.epicPresent === false;
  return JIRA_AGILE_PLANNING_TOOLS.has(tool) && rankComplete(tool, source);
}
function actorKey(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 255 || value.trim().length === 0) return false;
  // Preserve the native actor's permitted whitespace without admitting controls or broken Unicode.
  return !/[\p{Cc}\p{Surrogate}]/u.test(value.replaceAll(/[\t\r\n]/gu, ""));
}
function outcome(tool: string, source: Source): WidgetMessageKey[] {
  if (!jiraPlanningIdentityComplete(tool, source))
    return ["chat.jira.savedConfiguration.identityUnknown"];
  return jiraPlanningConfirmationUnavailable(tool)
    ? ["chat.jira.savedConfiguration.unconfirmed"]
    : mutationLabels(source, true);
}
function listFacts(source: Source, key: string, label: WidgetMessageKey): ReturnType<typeof fact> {
  const values = source[key];
  return strings(values, (value) => text(value) !== undefined, true)
    ? values.flatMap((value) => fact(label, value))
    : [];
}
function versionDetails(tool: string, source: Source): JiraAgileDetails {
  return {
    facts: [
      ...fact("chat.jira.fact.versionId", identity(source.versionId)),
      ...fact("chat.jira.fact.projectId", identity(source.projectId)),
      ...fact("chat.jira.fact.projectKey", source.projectKey),
      ...fact("chat.jira.fact.userKey", source.userKey),
      ...fact("chat.jira.issueContext.globalId", source.globalId),
      ...listFacts(source, "globalIds", "chat.jira.issueContext.globalId"),
    ],
    labels: [
      ...outcome(tool, source),
      "chat.jira.versionLinkWrite.completeSet",
      tool.startsWith("jira_delete_")
        ? "chat.jira.linkMutation.requestedAbsent"
        : "chat.jira.linkMutation.requestedPresent",
    ],
  };
}
function categoryDetails(tool: string, source: Source): JiraAgileDetails {
  return {
    facts: [
      ...fact("chat.jira.planning.categoryId", identity(source.categoryId)),
      ...fact("chat.jira.fact.userKey", source.userKey),
    ],
    labels: [
      ...outcome(tool, source),
      tool === "jira_delete_project_category"
        ? "chat.jira.categoryWrite.deleteUnconfirmed"
        : "chat.jira.categoryWrite.metadataOnly",
    ],
  };
}
function estimationDetails(tool: string, source: Source): JiraAgileDetails {
  const complete = jiraPlanningIdentityComplete(tool, source);
  const facts = [
    ...fact("chat.jira.properties.issueId", identity(source.issueId)),
    ...fact("chat.jira.fact.issue", source.issueKey),
    ...fact("chat.jira.fact.boardId", identity(source.boardId)),
    ...fact("chat.jira.configuration.fieldId", source.fieldId),
    ...fact("chat.jira.fact.userKey", source.userKey),
  ];
  if (complete)
    facts.push({
      label:
        source.outcome === "succeeded"
          ? "chat.jira.planning.observedEstimate"
          : "chat.jira.planning.requestedEstimate",
      value: String(source.estimationValue),
    });
  return { facts, labels: [...outcome(tool, source), estimationUnitLabel(complete, source)] };
}
function issueDetails(tool: string, source: Source): JiraAgileDetails {
  const rank = tool !== "jira_epic_remove_issues";
  return {
    facts: [
      ...fact("chat.jira.fact.userKey", source.userKey),
      ...fact("chat.jira.fact.boardId", identity(source.boardId)),
      ...fact("chat.jira.configuration.fieldId", source.fieldId),
      ...listFacts(source, "issueIds", "chat.jira.properties.issueId"),
      ...listFacts(source, "issueKeys", "chat.jira.fact.issue"),
      ...fact("chat.jira.planning.anchorId", identity(source.anchorIssueId)),
      ...fact("chat.jira.planning.anchorKey", source.anchorIssueKey),
    ],
    labels: [
      ...outcome(tool, source),
      rank ? "chat.jira.planning.rankUnconfirmed" : "chat.jira.planning.epicTargetAbsent",
      ...(rank && source.rankDirection === "before" ? ["chat.jira.planning.before" as const] : []),
      ...(rank && source.rankDirection === "after" ? ["chat.jira.planning.after" as const] : []),
    ],
  };
}
export function jiraPlanningMutationDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (JIRA_VERSION_LINK_WRITE_TOOLS.has(tool)) return [versionDetails(tool, source)];
  if (JIRA_CATEGORY_WRITE_TOOLS.has(tool)) return [categoryDetails(tool, source)];
  if (!JIRA_AGILE_PLANNING_TOOLS.has(tool)) return [];
  return [
    tool === "jira_set_issue_estimation"
      ? estimationDetails(tool, source)
      : issueDetails(tool, source),
  ];
}
function estimationUnitLabel(complete: boolean, source: Source): WidgetMessageKey {
  if (!complete) return "chat.jira.planning.unitUnknown";
  return source.estimationUnit === "seconds"
    ? "chat.jira.planning.seconds"
    : "chat.jira.planning.nativeBoardNumber";
}
