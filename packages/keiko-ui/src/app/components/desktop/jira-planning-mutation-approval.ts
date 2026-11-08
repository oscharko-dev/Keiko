import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraDraftValueOf, type JiraDraftField, type JiraDraftValue } from "./jiraDraftTree";
import { jiraPresentationRecord as record } from "./jira-presentation-values";
import { jiraReviewedPropertyNodes } from "./jira-property-mutation-presentation";
import {
  jiraReviewedMutationScalar as scalar,
  jiraReviewedVersionSnapshot,
} from "./jira-structural-mutation-approval";
import {
  JIRA_PLANNING_MUTATION_TOOLS,
  JIRA_VERSION_LINK_WRITE_TOOLS,
  JIRA_CATEGORY_WRITE_TOOLS,
} from "./jira-planning-mutation-presentation";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor",
  expectedProjectId: "chat.jira.structural.reviewedProject",
  versionId: "chat.jira.fact.versionId",
  expectedVersionSnapshot: "chat.jira.structural.reviewedVersion",
  expectedLinks: "chat.jira.versionLinkWrite.reviewedLinks",
  globalId: "chat.jira.issueContext.globalId",
  valueNodes: "chat.jira.propertyMutation.requestedValue",
  confirmAll: "chat.jira.versionLinkWrite.deleteAll",
  expectedCategory: "chat.jira.categoryWrite.reviewed",
  name: "chat.jira.structural.nativeName",
  description: "chat.jira.structural.nativeDescription",
  confirmUnverifiedDeletion: "chat.jira.categoryWrite.acceptUnconfirmed",
  boardId: "chat.jira.fact.boardId",
  expectedBoardName: "chat.jira.configuration.reviewedBoardName",
  rankCustomFieldId: "chat.jira.planning.rankField",
  direction: "chat.jira.planning.direction",
  expectedAnchorRank: "chat.jira.planning.reviewedAnchorRank",
  expectedRank: "chat.jira.planning.reviewedRank",
  epicIdOrKey: "chat.jira.planning.epicSelection",
  anchorEpicIdOrKey: "chat.jira.planning.anchorEpic",
  anchorIssueIdOrKey: "chat.jira.planning.anchorKey",
  issues: "chat.jira.planning.reviewedIssues",
  issueIdOrKey: "chat.jira.fact.issue",
  expectedEpic: "chat.jira.planning.reviewedEpic",
  fieldId: "chat.jira.configuration.fieldId",
  expectedValue: "chat.jira.planning.reviewedEstimate",
  unit: "chat.jira.planning.inputUnit",
  value: "chat.jira.planning.requestedEstimate",
};
const GROUP_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  ...LABELS,
  id: "chat.jira.planning.nativeId",
  key: "chat.jira.fact.issue",
};
const literal = (text: string): JiraDraftValue => ({ kind: "text", text });
function selected(operation: string | undefined): string | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  return tool !== undefined && JIRA_PLANNING_MUTATION_TOOLS.has(tool) ? tool : undefined;
}
function reviewedGroup(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const source = record(value);
  if (source === undefined) return scalar(value, t);
  return {
    kind: "group",
    members: Object.entries(source).map(([key, item]) => ({
      name: GROUP_LABELS[key] === undefined ? key : t(GROUP_LABELS[key]),
      value:
        key === "expectedEpic" && item !== null
          ? reviewedGroup(item, t)
          : specialScalar(key, item, t),
    })),
  };
}
function reviewedIssues(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  return Array.isArray(value)
    ? {
        kind: "list",
        items: value.map((entry: unknown, index) => ({
          position: index + 1,
          value: reviewedGroup(entry, t),
        })),
      }
    : jiraDraftValueOf(value);
}
function reviewedLinks(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (!Array.isArray(value)) return jiraDraftValueOf(value);
  if (value.length === 0) return literal(t("chat.jira.versionLinkWrite.reviewedEmpty"));
  return {
    kind: "list",
    items: value.map((entry: unknown, index) => {
      const source = record(entry);
      return {
        position: index + 1,
        value:
          source === undefined
            ? jiraDraftValueOf(entry)
            : ({
                kind: "group",
                members: [
                  { name: t("chat.jira.issueContext.globalId"), value: scalar(source.globalId, t) },
                  {
                    name: t("chat.jira.propertyMutation.reviewedValue"),
                    value: jiraReviewedPropertyNodes(source.valueNodes, t),
                  },
                ],
              } satisfies JiraDraftValue),
      };
    }),
  };
}
const UNITS: Readonly<Record<string, WidgetMessageKey>> = {
  minutes: "chat.jira.planning.minutes",
  "board-number": "chat.jira.planning.nativeBoardNumber",
  before: "chat.jira.planning.before",
  after: "chat.jira.planning.after",
};
const NULL_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedEpic: "chat.jira.planning.reviewedNoEpic",
  expectedValue: "chat.jira.planning.reviewedEmptyEstimate",
  expectedRank: "chat.jira.planning.reviewedEmptyRank",
  expectedAnchorRank: "chat.jira.planning.reviewedEmptyRank",
};
function specialScalar(key: string, value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (value === null && NULL_LABELS[key] !== undefined) return literal(t(NULL_LABELS[key]));
  const unit =
    (key === "unit" || key === "direction") && typeof value === "string" ? UNITS[value] : undefined;
  return unit === undefined ? scalar(value, t) : literal(t(unit));
}
function reviewedValue(key: string, value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (key === "valueNodes") return jiraReviewedPropertyNodes(value, t);
  if (key === "expectedLinks") return reviewedLinks(value, t);
  if (key === "expectedVersionSnapshot") return jiraReviewedVersionSnapshot(value, t);
  if (key === "expectedCategory") return reviewedGroup(value, t);
  if (key === "issues") return reviewedIssues(value, t);
  return specialScalar(key, value, t);
}
export function jiraPlanningMutationFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  return selected(operation) === undefined || LABELS[key] === undefined
    ? undefined
    : [{ id: t(LABELS[key]), value: reviewedValue(key, value, t) }];
}
function contextLabels(tool: string): readonly WidgetMessageKey[] {
  if (JIRA_VERSION_LINK_WRITE_TOOLS.has(tool))
    return ["chat.jira.versionLinkWrite.completeSet", "chat.jira.versionLinkWrite.replaceValue"];
  if (JIRA_CATEGORY_WRITE_TOOLS.has(tool))
    return [
      "chat.jira.categoryWrite.admin",
      tool === "jira_delete_project_category"
        ? "chat.jira.categoryWrite.deleteUnconfirmed"
        : "chat.jira.categoryWrite.metadataOnly",
    ];
  if (tool === "jira_set_issue_estimation") return ["chat.jira.planning.estimateInputHelp"];
  return [
    tool === "jira_epic_remove_issues"
      ? "chat.jira.planning.epicRemovalHelp"
      : "chat.jira.planning.rankUnconfirmed",
  ];
}
export function jiraPlanningMutationContextFacts(
  operation: string | undefined,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] {
  const tool = selected(operation);
  return tool === undefined
    ? []
    : ["chat.jira.structural.noAtomicSnapshot" as const, ...contextLabels(tool)].map((label) => ({
        id: t("chat.jira.savedConfiguration.nativeLimitation"),
        value: literal(t(label)),
      }));
}
