import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraAccessDetails } from "./jira-access-presentation";
import { jiraAdministrationDetails } from "./jira-administration-presentation";
import { jiraSchemeReviewDetails } from "./jira-scheme-review-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
export const JIRA_PROJECT_ASSOCIATION_TOOLS: ReadonlySet<string> = new Set([
  "jira_project_permission_scheme",
  "jira_project_issue_security_scheme",
  "jira_project_security_levels",
  "jira_project_workflow_scheme",
  "jira_project_priority_scheme",
]);
function projectFacts(source: Source): JiraOutcomeFact[] {
  return [
    ...fact("chat.jira.fact.projectId", source.projectId),
    ...fact("chat.jira.fact.projectKey", source.projectKey),
  ];
}
function withProject(cards: readonly JiraAgileDetails[], source: Source): readonly JiraAgileDetails[] {
  const context = projectFacts(source);
  const labels = new Set(context.map(({ label }) => label));
  return cards.map((card, index) =>
    index === 0
      ? { ...card, facts: [...context, ...card.facts.filter(({ label }) => !labels.has(label))] }
      : card,
  );
}
function mappings(source: Source): readonly JiraAgileDetails[] {
  if (text(source.id) === undefined)
    return text(source.issueTypeId) === undefined
      ? []
      : [jiraAdministrationDetails("jira_workflow_scheme", source)];
  const head = jiraAdministrationDetails("jira_workflow_scheme", source);
  const rows = Array.isArray(source.items) ? source.items : [];
  return [
    {
      ...head,
      labels: [...head.labels, "chat.jira.access.configurationOnly"] satisfies WidgetMessageKey[],
    },
    ...rows.flatMap((value: unknown) => {
      const row = record(value);
      return row === undefined ? [] : [jiraAdministrationDetails("jira_workflow_scheme", {
        ...row, schemeId: source.schemeId,
      })];
    }),
  ];
}
function accessibleLevels(source: Source): readonly JiraAgileDetails[] {
  if (!Array.isArray(source.items)) return jiraAccessDetails("jira_security_level", source);
  const rows = source.items;
  const total = source.total;
  const knownScope = source.levelsScope === "accessible";
  const facts: JiraOutcomeFact[] = knownScope && typeof total === "number" &&
    Number.isSafeInteger(total) && total >= 0
    ? [{ label: "chat.jira.association.accessibleLevelCount", value: String(total) }]
    : [];
  return [
    {
      facts,
      labels: [knownScope
        ? "chat.jira.association.accessibleLevelsScope"
        : "chat.jira.association.levelsScopeUnknown"],
    },
    ...rows.flatMap((value: unknown) => {
      const level = record(value);
      return level === undefined ? [] : jiraAccessDetails("jira_security_level", level);
    }),
  ];
}
function priority(source: Source): JiraAgileDetails {
  const name = text(source.name);
  const body = text(source.description);
  const options = source.optionIds;
  const knownOptions = Array.isArray(options) && options.every((value: unknown) => typeof value === "string");
  const review = jiraSchemeReviewDetails("priority", source);
  const labels: WidgetMessageKey[] = ["chat.jira.access.configurationOnly"];
  if (!knownOptions) labels.push("chat.jira.association.priorityOptionsUnknown");
  if (typeof source.defaultScheme === "boolean")
    labels.push(source.defaultScheme
      ? "chat.jira.association.defaultPriorityScheme"
      : "chat.jira.association.notDefaultPriorityScheme");
  const facts = [
    ...fact("chat.jira.access.schemeId", source.id),
    ...fact("chat.jira.association.defaultPriorityId", source.defaultOptionId),
  ];
  if (knownOptions) facts.push(
    ...fact("chat.jira.association.priorityIds", options.join(", ")),
    { label: "chat.jira.association.priorityCount", value: String(options.length) },
  );
  return {
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { body }),
    facts: [...facts, ...review.facts],
    labels: [...labels, ...review.labels],
  };
}
/** Project context is observed independently; association metadata does not grant permission. */
export function jiraProjectAssociationDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  let cards: readonly JiraAgileDetails[];
  switch (tool) {
    case "jira_project_permission_scheme":
      cards = jiraAccessDetails("jira_permission_scheme", source);
      break;
    case "jira_project_issue_security_scheme":
      cards = jiraAccessDetails("jira_issue_security_scheme", source);
      break;
    case "jira_project_security_levels":
      cards = accessibleLevels(source);
      break;
    case "jira_project_workflow_scheme":
      cards = mappings(source);
      break;
    case "jira_project_priority_scheme":
      cards = text(source.id) === undefined ? [] : [priority(source)];
      break;
    default:
      return [];
  }
  return withProject(cards, source);
}
