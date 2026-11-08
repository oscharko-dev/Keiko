import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraDraftValueOf, type JiraDraftField, type JiraDraftValue } from "./jiraDraftTree";
import { jiraPresentationRecord as record } from "./jira-presentation-values";
import {
  jiraReviewedMutationScalar as scalar,
  jiraNativeOrderPosition,
} from "./jira-structural-mutation-approval";
import {
  JIRA_CONFIGURATION_MUTATION_TOOLS,
  JIRA_SCREEN_CONFIGURATION_TOOLS,
} from "./jira-configuration-mutation-presentation";
import { JIRA_SPRINT_LIFECYCLE_TOOLS } from "./jira-sprint-lifecycle-presentation";
import {
  jiraSprintLifecycleFacts,
  jiraSprintLifecycleContextFacts,
} from "./jira-sprint-lifecycle-approval";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  screenId: "chat.jira.fact.screenId",
  tabId: "chat.jira.fact.screenTabId",
  fieldId: "chat.jira.configuration.fieldId",
  expectedScreenName: "chat.jira.screenTabs.expectedScreenName",
  expectedTabs: "chat.jira.configuration.reviewedTabs",
  expectedFields: "chat.jira.configuration.reviewedFields",
  expectedFieldName: "chat.jira.configuration.reviewedFieldName",
  acceptUnverifiedDefault: "chat.jira.configuration.acceptDefault",
  showWhenEmpty: "chat.jira.configuration.showWhenEmpty",
  boardId: "chat.jira.fact.boardId",
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor",
  expectedBoardName: "chat.jira.configuration.reviewedBoardName",
  expectedBoardType: "chat.jira.configuration.reviewedBoardType",
  expectedFilterId: "chat.jira.configuration.reviewedFilter",
  expectedValue: "chat.jira.configuration.reviewedVelocity",
  value: "chat.jira.configuration.requestedVelocity",
  position: "chat.jira.structural.requestedPosition",
};
function idLabel(fields: boolean): WidgetMessageKey {
  return fields ? "chat.jira.configuration.fieldId" : "chat.jira.fact.screenTabId";
}
const ROW_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  name: "chat.jira.structural.nativeName",
  type: "chat.jira.configuration.fieldType",
  showWhenEmpty: "chat.jira.configuration.showWhenEmpty",
};
function toolOf(operation: string | undefined): string | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  return tool !== undefined && JIRA_CONFIGURATION_MUTATION_TOOLS.has(tool) ? tool : undefined;
}
function layout(value: unknown, t: OptionalWidgetTranslate, fields: boolean): JiraDraftValue {
  if (!Array.isArray(value)) return jiraDraftValueOf(value);
  if (value.length === 0)
    return { kind: "text", text: t("chat.jira.screenTabs.reviewedEmptyFields") };
  return {
    kind: "list",
    items: value.map((entry: unknown, index) => {
      const source = record(entry);
      if (source === undefined) return { position: index + 1, value: jiraDraftValueOf(entry) };
      return {
        position: index + 1,
        value: {
          kind: "group",
          members: Object.entries(source).map(([key, item]) => {
            const label = key === "id" ? idLabel(fields) : ROW_LABELS[key];
            return { name: label === undefined ? key : t(label), value: scalar(item, t) };
          }),
        } satisfies JiraDraftValue,
      };
    }),
  };
}
function valueOf(
  tool: string,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): JiraDraftValue {
  if (key === "expectedTabs" || key === "expectedFields")
    return layout(value, t, key === "expectedFields");
  if (key === "position" && tool !== "jira_move_screen_tab")
    return jiraNativeOrderPosition(value, t);
  return scalar(value, t);
}
export function jiraConfigurationMutationFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  const tool = toolOf(operation);
  if (tool === undefined) return undefined;
  if (JIRA_SPRINT_LIFECYCLE_TOOLS.has(tool)) return jiraSprintLifecycleFacts(tool, key, value, t);
  const label =
    key === "position" && tool === "jira_move_screen_tab"
      ? "chat.jira.configuration.zeroBasedPosition"
      : LABELS[key];
  return label === undefined ? undefined : [{ id: t(label), value: valueOf(tool, key, value, t) }];
}
const CONTEXT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  jira_add_default_screen_field: "chat.jira.configuration.defaultUnconfirmed",
  jira_delete_board: "chat.jira.configuration.boardDeleteUnconfirmed",
  jira_set_board_refined_velocity: "chat.jira.configuration.velocitySettingOnly",
  jira_add_screen_tab_field: "chat.jira.configuration.addPositionUnspecified",
  jira_remove_screen_tab_field: "chat.jira.configuration.removeMembershipOnly",
  jira_move_screen_tab: "chat.jira.configuration.zeroBasedHelp",
};
export function jiraConfigurationMutationContextFacts(
  operation: string | undefined,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] {
  const tool = toolOf(operation);
  if (tool === undefined) return [];
  if (JIRA_SPRINT_LIFECYCLE_TOOLS.has(tool)) return jiraSprintLifecycleContextFacts(tool, t);
  const labels: WidgetMessageKey[] = ["chat.jira.structural.noAtomicSnapshot"];
  if (JIRA_SCREEN_CONFIGURATION_TOOLS.has(tool))
    labels.push("chat.jira.configuration.displayOnly", "chat.jira.configuration.explicitAdmin");
  const extra = CONTEXT_LABELS[tool];
  if (extra !== undefined) labels.push(extra);
  return labels.map((label) => ({
    id: t("chat.jira.savedConfiguration.nativeLimitation"),
    value: { kind: "text", text: t(label) },
  }));
}
