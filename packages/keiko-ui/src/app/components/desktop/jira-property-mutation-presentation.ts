import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { JIRA_ENTITY_PROPERTY_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import { jiraDraftValueOf, type JiraDraftField, type JiraDraftValue } from "./jiraDraftTree";
import {
  jiraPropertyContextComplete,
  jiraPropertyContextFacts,
  jiraPropertyValueDetails,
} from "./jira-property-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const OPERATIONS: ReadonlySet<string> = new Set(JIRA_ENTITY_PROPERTY_MUTATIONS);
const TOOL_ENTITIES: ReadonlyMap<string, string> = new Map(
  JIRA_ENTITY_PROPERTY_MUTATIONS.map(
    (operation) =>
      [
        operation.replace(/[.-]/gu, "_"),
        operation.slice(
          operation.startsWith("jira.set-") ? "jira.set-".length : "jira.delete-".length,
          -"-property".length,
        ),
      ] as const,
  ),
);
export const JIRA_PROPERTY_MUTATION_TOOLS: ReadonlySet<string> = new Set(TOOL_ENTITIES.keys());
const ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  propertyKey: "chat.jira.properties.key",
  boardId: "chat.jira.fact.boardId",
  sprintId: "chat.jira.fact.sprintId",
  issueIdOrKey: "chat.jira.propertyMutation.issueSelection",
  commentId: "chat.jira.fact.commentId",
  dashboardId: "chat.jira.fact.dashboardId",
  itemId: "chat.jira.properties.selectedItemId",
  issueTypeId: "chat.jira.fact.issueTypeId",
  projectIdOrKey: "chat.jira.fact.projectIdOrKey",
  username: "chat.jira.fact.userName",
  userKey: "chat.jira.fact.userKey",
};
const REVIEW_LABELS: Readonly<Partial<Record<WidgetMessageKey, WidgetMessageKey>>> = {
  "chat.jira.properties.null": "chat.jira.propertyMutation.null",
  "chat.jira.properties.emptyText": "chat.jira.propertyMutation.emptyText",
  "chat.jira.properties.emptyObject": "chat.jira.propertyMutation.emptyObject",
  "chat.jira.properties.emptyArray": "chat.jira.propertyMutation.emptyArray",
  "chat.jira.properties.true": "chat.jira.propertyMutation.true",
  "chat.jira.properties.false": "chat.jira.propertyMutation.false",
};
function textValue(text: string): JiraDraftValue {
  return { kind: "text", text };
}
function nodeValue(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const source = record(value);
  if (source === undefined) return textValue(t("chat.jira.properties.valueUnknown"));
  const details = jiraPropertyValueDetails(source);
  const labels = details.labels.map((label) => t(REVIEW_LABELS[label] ?? label));
  return {
    kind: "group",
    members: [
      { name: t("chat.jira.propertyMutation.node"), value: textValue(labels.join(" · ")) },
      ...details.facts.map((entry) => ({ name: t(entry.label), value: textValue(entry.value) })),
      ...(details.body === undefined
        ? []
        : [{ name: t("chat.jira.properties.value"), value: textValue(details.body) }]),
    ],
  };
}
function nodeList(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  return Array.isArray(value) && value.length > 0
    ? {
        kind: "list",
        items: value.map((entry: unknown, index) => ({
          position: index + 1,
          value: nodeValue(entry, t),
        })),
      }
    : textValue(t("chat.jira.properties.valueUnknown"));
}
export { nodeList as jiraReviewedPropertyNodes };
/** The same typed value presenter names every reviewed/requested node; no JSON is decoded here. */
export function jiraPropertyMutationFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  if (operation === undefined || !OPERATIONS.has(operation)) return undefined;
  if (key === "valueNodes" || key === "expectedValueNodes")
    return [
      {
        id: t(
          key === "valueNodes"
            ? "chat.jira.propertyMutation.requestedValue"
            : "chat.jira.propertyMutation.reviewedValue",
        ),
        value: nodeList(value, t),
      },
    ];
  if (key === "expectAbsent")
    return [
      {
        id: t("chat.jira.propertyMutation.reviewedAbsence"),
        value:
          value === true
            ? textValue(t("chat.jira.propertyMutation.absenceExpected"))
            : jiraDraftValueOf(value),
      },
    ];
  const label = ARGUMENT_LABELS[key];
  return label === undefined ? undefined : [{ id: t(label), value: jiraDraftValueOf(value) }];
}
export function jiraPropertyMutationIdentityComplete(tool: string, source: Source): boolean {
  const target = tool.startsWith("jira_set_");
  const entity = TOOL_ENTITIES.get(tool);
  return (
    source.propertyPresent === target &&
    entity !== undefined &&
    jiraPropertyContextComplete(entity, source)
  );
}
function presenceLabels(tool: string, source: Source): readonly WidgetMessageKey[] {
  const target = tool.startsWith("jira_set_");
  if (!jiraPropertyMutationIdentityComplete(tool, source))
    return ["chat.jira.propertyMutation.presenceUnknown"];
  if (source.outcome === "succeeded")
    return [
      target
        ? "chat.jira.propertyMutation.confirmedPresent"
        : "chat.jira.propertyMutation.confirmedAbsent",
    ];
  if (source.outcome === "rejected" && source.reason === "conflict" && source.unchanged === true)
    return [
      target
        ? "chat.jira.propertyMutation.alreadyPresent"
        : "chat.jira.propertyMutation.alreadyAbsent",
    ];
  return [
    "chat.jira.propertyMutation.targetUnconfirmed",
    target
      ? "chat.jira.propertyMutation.requestedPresent"
      : "chat.jira.propertyMutation.requestedAbsent",
  ];
}
/** Identity context survives uncertainty, while target flags never become confirmation by themselves. */
export function jiraPropertyMutationDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (!JIRA_PROPERTY_MUTATION_TOOLS.has(tool)) return [];
  const labels = [...presenceLabels(tool, source)];
  if (typeof source.selectedItemId === "string")
    labels.push("chat.jira.properties.requestedItemContext");
  return [
    {
      facts: [
        ...jiraPropertyContextFacts(source),
        ...fact("chat.jira.properties.key", source.propertyKey),
      ],
      labels,
    },
  ];
}
