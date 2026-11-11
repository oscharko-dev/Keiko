import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraIssueTypeReviewDetails } from "./jira-schema-review-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
const ISSUE_TYPES = new Set([
  "jira_global_issue_types",
  "jira_issue_type",
  "jira_issue_type_page",
  "jira_issue_type_alternatives",
]);
const PRIORITIES = new Set(["jira_priorities", "jira_priority", "jira_priority_page"]);
const RESOLUTIONS = new Set(["jira_resolutions", "jira_resolution", "jira_resolution_page"]);
const STATUSES = new Set(["jira_statuses", "jira_status", "jira_status_page"]);
const STATUS_CATEGORIES = new Set(["jira_status_categories", "jira_status_category"]);
const PROJECT_CATEGORIES = new Set(["jira_project_categories", "jira_project_category"]);
const PROJECT_TYPES = new Set(["jira_project_types", "jira_project_type_definition"]);
export const JIRA_CORE_METADATA_TOOLS: ReadonlySet<string> = new Set([
  ...ISSUE_TYPES,
  ...PRIORITIES,
  ...RESOLUTIONS,
  ...STATUSES,
  ...STATUS_CATEGORIES,
  ...PROJECT_CATEGORIES,
  ...PROJECT_TYPES,
  "jira_project_statuses",
]);

function records(value: unknown): readonly Source[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(record);
  return items.every((item) => item !== undefined) ? items : undefined;
}
function identityLabel(tool: string): WidgetMessageKey {
  if (ISSUE_TYPES.has(tool) || tool === "jira_project_statuses")
    return "chat.jira.fact.issueTypeId";
  if (PRIORITIES.has(tool)) return "chat.jira.core.priorityId";
  if (RESOLUTIONS.has(tool)) return "chat.jira.core.resolutionId";
  if (STATUSES.has(tool)) return "chat.jira.core.statusId";
  return STATUS_CATEGORIES.has(tool)
    ? "chat.jira.core.statusCategoryId"
    : "chat.jira.core.projectCategoryId";
}
function triStateLabel(
  value: unknown,
  yes: WidgetMessageKey,
  no: WidgetMessageKey,
  unknown: WidgetMessageKey,
): WidgetMessageKey {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
function subtypeLabel(source: Source): WidgetMessageKey {
  return triStateLabel(
    source.subtask,
    "chat.jira.core.subtaskType",
    "chat.jira.core.standardType",
    "chat.jira.core.typeKindUnknown",
  );
}
function categoryFacts(source: Source): JiraOutcomeFact[] {
  return [
    ...fact("chat.jira.core.statusCategoryId", source.id),
    ...fact("chat.jira.core.statusCategoryKey", source.key),
    ...fact("chat.jira.core.statusCategoryName", source.name),
    ...fact("chat.jira.core.colorName", source.colorName),
  ];
}
function statusDetails(source: Source): {
  readonly facts: readonly JiraOutcomeFact[];
  readonly labels: readonly WidgetMessageKey[];
} {
  const category = record(source.statusCategory);
  return {
    facts: [
      ...fact("chat.jira.core.statusColor", source.statusColor),
      ...(category === undefined ? [] : categoryFacts(category)),
    ],
    labels: category === undefined ? ["chat.jira.core.statusCategoryUnknown"] : [],
  };
}
function extraDetails(
  tool: string,
  source: Source,
): {
  readonly facts: readonly JiraOutcomeFact[];
  readonly labels: readonly WidgetMessageKey[];
} {
  if (tool === "jira_project_statuses") return { facts: [], labels: [subtypeLabel(source)] };
  if (ISSUE_TYPES.has(tool)) {
    const review = jiraIssueTypeReviewDetails(source);
    return {
      facts: [...fact("chat.jira.fact.avatarId", source.avatarId), ...review.facts],
      labels: [subtypeLabel(source), ...review.labels],
    };
  }
  if (STATUSES.has(tool)) return statusDetails(source);
  if (STATUS_CATEGORIES.has(tool))
    return {
      facts: categoryFacts(source).filter(
        ({ label }) => label !== "chat.jira.core.statusCategoryId",
      ),
      labels: [],
    };
  if (PRIORITIES.has(tool))
    return { facts: fact("chat.jira.core.statusColor", source.statusColor), labels: [] };
  return { facts: [], labels: [] };
}
function named(tool: string, source: Source): JiraAgileDetails | undefined {
  const name = text(source.name);
  const id = text(source.id);
  if (name === undefined && id === undefined) return undefined;
  const body = text(source.description);
  const details = extraDetails(tool, source);
  return {
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { body }),
    facts: [...fact(identityLabel(tool), id), ...details.facts],
    labels: [
      ...details.labels,
      ...(RESOLUTIONS.has(tool) && id === undefined
        ? (["chat.jira.core.resolutionIdUnknown"] as const)
        : []),
    ],
  };
}
function projectType(source: Source): JiraAgileDetails | undefined {
  const key = text(source.key);
  if (key === undefined) return undefined;
  return {
    name: text(source.formattedKey) ?? key,
    facts: [
      { label: "chat.jira.fact.projectType", value: key },
      ...fact("chat.jira.core.descriptionTranslationKey", source.descriptionI18nKey),
      ...fact("chat.jira.core.statusColor", source.color),
    ],
    labels: [],
  };
}
function statusCards(value: unknown): readonly JiraAgileDetails[] | undefined {
  const statuses = records(value);
  if (statuses === undefined) return undefined;
  const result: JiraAgileDetails[] = [];
  for (const status of statuses) {
    const child = named("jira_status", status);
    if (child === undefined) return undefined;
    result.push(child);
  }
  return result;
}
function issueTypeStatuses(source: Source): readonly JiraAgileDetails[] {
  const head = named("jira_project_statuses", source);
  if (head === undefined) return [];
  const children = statusCards(source.statuses);
  return [
    {
      ...head,
      facts: [
        ...head.facts,
        ...(children === undefined
          ? []
          : [
              {
                label: "chat.jira.core.configuredStatusCount",
                value: String(children.length),
              } satisfies JiraOutcomeFact,
            ]),
      ],
      labels: [
        ...head.labels,
        ...(children === undefined ? (["chat.jira.core.statusesUnknown"] as const) : []),
      ],
    },
    ...(children ?? []).map((child) => ({
      ...child,
      facts: [...fact("chat.jira.fact.issueTypeId", source.id), ...child.facts],
    })),
  ];
}
function projectStatuses(data: Source): readonly JiraAgileDetails[] {
  const context = [
    ...fact("chat.jira.fact.projectId", data.projectId),
    ...fact("chat.jira.fact.projectKey", data.projectKey),
  ];
  return [
    ...(context.length === 0
      ? []
      : [
          {
            facts: context,
            labels: ["chat.jira.core.projectStatusesScope"] satisfies WidgetMessageKey[],
          },
        ]),
    ...(records(data.items) ?? [data]).flatMap(issueTypeStatuses),
  ];
}
function requestContext(tool: string, data: Source): JiraOutcomeFact[] {
  if (tool === "jira_issue_type_alternatives")
    return fact("chat.jira.core.sourceIssueTypeId", data.issueTypeId);
  if (tool === "jira_resolution")
    return fact("chat.jira.core.requestedResolutionId", data.resolutionId);
  return [];
}
/** Saved native metadata stays readable text; colors, icons and self URLs never become rendering inputs. */
export function jiraCoreMetadataDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_CORE_METADATA_TOOLS.has(tool)) return [];
  if (tool === "jira_project_statuses") return projectStatuses(data);
  const context = requestContext(tool, data);
  const cards = (records(data.items) ?? [data]).flatMap((source) => {
    const item = PROJECT_TYPES.has(tool) ? projectType(source) : named(tool, source);
    if (item === undefined) return [];
    return [{ ...item, facts: [...context, ...item.facts] }];
  });
  return cards.length === 0 && context.length > 0 ? [{ facts: context, labels: [] }] : cards;
}
