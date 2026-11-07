import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_JQL_TOOLS: ReadonlySet<string> = new Set(["jira_jql_autocomplete", "jira_jql_suggestions"]);
const SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  "visible-fields": "chat.jira.jql.visibleFields",
  "visible-functions": "chat.jira.jql.visibleFunctions",
  "reserved-words": "chat.jira.jql.reservedWords",
  "native-suggestions": "chat.jira.jql.nativeSuggestions",
};
const FIELD_FLAGS: Readonly<Record<string, readonly [WidgetMessageKey, WidgetMessageKey, WidgetMessageKey]>> = {
  auto: ["chat.jira.jql.autoTrue", "chat.jira.jql.autoFalse", "chat.jira.jql.autoUnknown"],
  orderable: ["chat.jira.lookup.orderable", "chat.jira.lookup.notOrderable", "chat.jira.lookup.orderableUnknown"],
  searchable: ["chat.jira.lookup.searchable", "chat.jira.lookup.notSearchable", "chat.jira.lookup.searchableUnknown"],
};
function strings(value: unknown, label: WidgetMessageKey, countLabel: WidgetMessageKey): JiraOutcomeFact[] | undefined {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) return undefined;
  return [...fact(label, value.join(", ")), { label: countLabel, value: String(value.length) }];
}
function item(source: Source, category: unknown): JiraAgileDetails | undefined {
  const value = text(source.value);
  if (value === undefined) return undefined;
  const facts: JiraOutcomeFact[] = [];
  const labels: WidgetMessageKey[] = [];
  if (category === "fields" || category === "functions") {
    const types = strings(source.types, "chat.jira.jql.types", "chat.jira.jql.typeCount");
    if (types === undefined) labels.push("chat.jira.jql.typesUnknown");
    else facts.push(...types);
  }
  if (category === "fields") {
    facts.push(...fact("chat.jira.jql.customFieldIdentifier", source.cfid));
    const operators = strings(source.operators, "chat.jira.jql.operators", "chat.jira.jql.operatorCount");
    if (operators === undefined) labels.push("chat.jira.jql.operatorsUnknown");
    else facts.push(...operators);
    labels.push(...Object.entries(FIELD_FLAGS).map(([key, [yes, no, unknown]]) =>
      source[key] === true ? yes : source[key] === false ? no : unknown));
  }
  return { name: value, facts, labels };
}
function context(data: Source): JiraAgileDetails | undefined {
  if (text(data.metadataScope) === undefined && text(data.fieldName) === undefined) return undefined;
  const scope = typeof data.metadataScope === "string" && Object.hasOwn(SCOPES, data.metadataScope)
    ? SCOPES[data.metadataScope] : undefined;
  const labels: WidgetMessageKey[] = [scope ?? "chat.jira.jql.scopeUnknown", "chat.jira.jql.discoveryOnly"];
  if (data.fieldValue === "") labels.push("chat.jira.jql.emptyFieldPrefix");
  if (data.predicateValue === "") labels.push("chat.jira.jql.emptyPredicatePrefix");
  return {
    facts: [
      ...fact("chat.jira.jql.fieldName", data.fieldName),
      ...fact("chat.jira.jql.fieldPrefix", data.fieldValue),
      ...fact("chat.jira.jql.predicateName", data.predicateName),
      ...fact("chat.jira.jql.predicatePrefix", data.predicateValue),
    ],
    labels,
  };
}
/** Native plain tokens only; highlighted displayName markup never becomes a result or executable query. */
export function jiraJqlDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_JQL_TOOLS.has(tool)) return [];
  const head = context(data);
  const sources = Array.isArray(data.items) ? data.items : [data];
  return [
    ...(head === undefined ? [] : [head]),
    ...sources.flatMap((value: unknown) => {
      const source = record(value);
      const result = source === undefined ? undefined : item(source, data.category);
      return result === undefined ? [] : [result];
    }),
  ];
}
