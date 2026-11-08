import {
  isSafeAtlassianIdentifier,
  JIRA_SCREEN_CONFIGURATION_MUTATIONS,
  JIRA_BOARD_CONFIGURATION_MUTATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  JIRA_SPRINT_LIFECYCLE_TOOLS,
  jiraSprintLifecycleIdentityComplete,
  jiraSprintLifecycleConfirmationUnavailable,
  jiraSprintLifecycleDetails,
} from "./jira-sprint-lifecycle-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationText as text,
  jiraPresentationMutationLabels as mutationLabels,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_SCREEN_CONFIGURATION_TOOLS: ReadonlySet<string> = new Set(
  JIRA_SCREEN_CONFIGURATION_MUTATIONS.map((name) => name.replace(/[.-]/gu, "_")),
);
export const JIRA_BOARD_CONFIGURATION_TOOLS: ReadonlySet<string> = new Set(
  JIRA_BOARD_CONFIGURATION_MUTATIONS.map((name) => name.replace(/[.-]/gu, "_")),
);
export const JIRA_CONFIGURATION_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_SCREEN_CONFIGURATION_TOOLS,
  ...JIRA_BOARD_CONFIGURATION_TOOLS,
  ...JIRA_SPRINT_LIFECYCLE_TOOLS,
]);
export function jiraConfigurationConfirmationUnavailable(tool: string): boolean {
  return (
    tool === "jira_add_default_screen_field" ||
    tool === "jira_delete_board" ||
    jiraSprintLifecycleConfirmationUnavailable(tool)
  );
}
function boardId(value: unknown): string | undefined {
  const id = identity(value);
  return id !== undefined && Number.isSafeInteger(Number(id)) ? id : undefined;
}
function boardComplete(tool: string, source: Source): boolean {
  if (
    boardId(source.boardId) === undefined ||
    boardId(source.filterId) === undefined ||
    text(source.userKey) === undefined
  )
    return false;
  return tool === "jira_delete_board"
    ? source.boardPresent === false
    : typeof source.refinedVelocityEnabled === "boolean";
}
function fieldStateComplete(tool: string, source: Source): boolean {
  if (tool === "jira_move_screen_tab") return true;
  if (!isSafeAtlassianIdentifier(source.fieldId)) return false;
  if (tool === "jira_add_screen_tab_field") return source.fieldPresent === true;
  if (tool === "jira_remove_screen_tab_field") return source.fieldPresent === false;
  return (
    tool !== "jira_set_screen_field_show_when_empty" || typeof source.showWhenEmpty === "boolean"
  );
}
export function jiraConfigurationMutationIdentityComplete(tool: string, source: Source): boolean {
  if (JIRA_SPRINT_LIFECYCLE_TOOLS.has(tool))
    return jiraSprintLifecycleIdentityComplete(tool, source);
  if (JIRA_BOARD_CONFIGURATION_TOOLS.has(tool)) return boardComplete(tool, source);
  if (!JIRA_SCREEN_CONFIGURATION_TOOLS.has(tool)) return false;
  if (tool === "jira_add_default_screen_field")
    return (
      isSafeAtlassianIdentifier(source.fieldId) &&
      source.fieldPresent === true &&
      !Object.hasOwn(source, "screenId") &&
      !Object.hasOwn(source, "tabId")
    );
  return (
    identity(source.screenId) !== undefined &&
    identity(source.tabId) !== undefined &&
    fieldStateComplete(tool, source)
  );
}
function outcomeLabels(tool: string, source: Source): WidgetMessageKey[] {
  const complete = jiraConfigurationMutationIdentityComplete(tool, source);
  if (!complete) return ["chat.jira.savedConfiguration.identityUnknown"];
  if (jiraConfigurationConfirmationUnavailable(tool))
    return ["chat.jira.savedConfiguration.unconfirmed"];
  return mutationLabels(source, true);
}
function booleanLabels(tool: string, source: Source): WidgetMessageKey[] {
  if (
    tool !== "jira_set_board_refined_velocity" &&
    tool !== "jira_set_screen_field_show_when_empty"
  )
    return [];
  const value =
    tool === "jira_set_board_refined_velocity"
      ? source.refinedVelocityEnabled
      : source.showWhenEmpty;
  if (typeof value !== "boolean") return [];
  const observed =
    jiraConfigurationMutationIdentityComplete(tool, source) && source.outcome === "succeeded";
  return [
    observed
      ? "chat.jira.configuration.observedBoolean"
      : "chat.jira.configuration.requestedBoolean",
    value ? "chat.jira.propertyMutation.true" : "chat.jira.propertyMutation.false",
  ];
}
const FIELD_PRESENCE_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  jira_add_default_screen_field: "chat.jira.configuration.requestedDefaultFieldPresent",
  jira_add_screen_tab_field: "chat.jira.configuration.requestedFieldPresent",
  jira_remove_screen_tab_field: "chat.jira.configuration.requestedFieldAbsent",
};
function screenDetails(tool: string, source: Source): JiraAgileDetails {
  const isDefault = tool === "jira_add_default_screen_field";
  const parents = isDefault
    ? []
    : [
        ...fact("chat.jira.fact.screenId", identity(source.screenId)),
        ...fact("chat.jira.fact.screenTabId", identity(source.tabId)),
      ];
  const labels = [
    ...outcomeLabels(tool, source),
    "chat.jira.configuration.displayOnly" as const,
    ...booleanLabels(tool, source),
  ];
  if (isDefault) labels.push("chat.jira.configuration.defaultUnconfirmed");
  const presenceLabel = FIELD_PRESENCE_LABELS[tool];
  if (presenceLabel !== undefined) labels.push(presenceLabel);
  return {
    facts: [...parents, ...fact("chat.jira.configuration.fieldId", source.fieldId)],
    labels,
  };
}
function boardDetails(tool: string, source: Source): JiraAgileDetails {
  const labels = [...outcomeLabels(tool, source), ...booleanLabels(tool, source)];
  labels.push(
    tool === "jira_delete_board"
      ? "chat.jira.configuration.boardDeleteUnconfirmed"
      : "chat.jira.configuration.velocitySettingOnly",
  );
  return {
    facts: [
      ...fact("chat.jira.fact.boardId", boardId(source.boardId)),
      ...fact("chat.jira.fact.filterId", boardId(source.filterId)),
      ...fact("chat.jira.fact.userKey", source.userKey),
    ],
    labels,
  };
}
/** Receipts retain only their bound context; settings and requested absence are never inferred. */
export function jiraConfigurationMutationDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (JIRA_SPRINT_LIFECYCLE_TOOLS.has(tool)) return jiraSprintLifecycleDetails(tool, source);
  if (JIRA_BOARD_CONFIGURATION_TOOLS.has(tool)) return [boardDetails(tool, source)];
  return JIRA_SCREEN_CONFIGURATION_TOOLS.has(tool) ? [screenDetails(tool, source)] : [];
}
