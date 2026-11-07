import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_PROPERTY_TOOLS: ReadonlySet<string> = new Set([
  "jira_board_property_keys", "jira_board_property", "jira_sprint_property_keys", "jira_sprint_property",
  "jira_comment_property_keys", "jira_comment_property", "jira_dashboard_item_property_keys", "jira_dashboard_item_property",
  "jira_issue_property_keys", "jira_issue_property", "jira_issue_type_property_keys", "jira_issue_type_property",
  "jira_project_property_keys", "jira_project_property", "jira_user_property_keys", "jira_user_property",
]);
export const JIRA_PROPERTY_KEY_TOOLS: ReadonlySet<string> = new Set(
  [...JIRA_PROPERTY_TOOLS].filter((tool) => tool.endsWith("_keys")),
);
const CONTEXT: Readonly<Record<string, WidgetMessageKey>> = {
  boardId: "chat.jira.fact.boardId", sprintId: "chat.jira.fact.sprintId",
  issueId: "chat.jira.properties.issueId", issueKey: "chat.jira.fact.issue",
  commentId: "chat.jira.fact.commentId", dashboardId: "chat.jira.fact.dashboardId",
  selectedItemId: "chat.jira.properties.selectedItemId", issueTypeId: "chat.jira.fact.issueTypeId",
  projectId: "chat.jira.fact.projectId", projectKey: "chat.jira.fact.projectKey",
  userKey: "chat.jira.fact.userKey", username: "chat.jira.fact.userName",
};
const KINDS: Readonly<Record<string, WidgetMessageKey>> = {
  object: "chat.jira.properties.object", array: "chat.jira.properties.array",
  string: "chat.jira.properties.text", number: "chat.jira.properties.number",
  boolean: "chat.jira.properties.boolean", null: "chat.jira.properties.null",
};
function countFact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? [{ label, value: String(value) }] : [];
}
function header(tool: string, data: Source): JiraAgileDetails {
  const keys = JIRA_PROPERTY_KEY_TOOLS.has(tool);
  const labels: WidgetMessageKey[] = ["chat.jira.properties.observation", keys
    ? "chat.jira.properties.keysScope" : "chat.jira.properties.pointerHelp"];
  if (typeof data.selectedItemId === "string") labels.push("chat.jira.properties.requestedItemContext");
  if (!Array.isArray(data.items)) labels.push(keys ? "chat.jira.properties.keysUnknown" : "chat.jira.properties.valueUnknown");
  else if (data.items.length === 0) labels.push(keys ? "chat.jira.properties.keysEmpty" : "chat.jira.properties.valueUnknown");
  return {
    facts: [...Object.entries(CONTEXT).flatMap(([field, label]) => fact(label, data[field])),
      ...fact("chat.jira.properties.key", data.propertyKey),
      ...countFact(keys ? "chat.jira.properties.returnedKeys" : "chat.jira.properties.nodeCount", keys ? data.total : data.nodeCount)],
    labels,
  };
}
function keyCard(source: Source): JiraAgileDetails {
  const key = source.key;
  if (typeof key !== "string") return { facts: [], labels: ["chat.jira.properties.keyUnknown"] };
  const unselectable = key === "." || key === ".." || /[/\\%]/u.test(key);
  return { facts: fact("chat.jira.properties.key", key),
    labels: unselectable ? ["chat.jira.properties.unselectableKey"] : [] };
}
function valueFacts(source: Source): JiraAgileDetails {
  switch (source.kind) {
    case "null": return { facts: [], labels: [] };
    case "string": {
      if (typeof source.textValue !== "string") break;
      if (source.textValue === "") return { facts: [], labels: ["chat.jira.properties.emptyText"] };
      return { body: source.textValue, facts: [], labels: source.textValue.trim() === ""
        ? ["chat.jira.properties.whitespaceText"] : [] };
    }
    case "number":
      if (typeof source.numberValue === "number" && Number.isFinite(source.numberValue))
        return { facts: [{ label: "chat.jira.properties.value", value: String(source.numberValue) }], labels: [] };
      break;
    case "boolean":
      if (typeof source.booleanValue === "boolean") return { facts: [], labels: [source.booleanValue
        ? "chat.jira.properties.true" : "chat.jira.properties.false"] };
      break;
    case "object":
    case "array": {
      const facts = countFact("chat.jira.properties.children", source.childCount);
      const labels: WidgetMessageKey[] = facts.length === 0 ? ["chat.jira.properties.childrenUnknown"]
        : source.childCount === 0 ? [source.kind === "array" ? "chat.jira.properties.emptyArray" : "chat.jira.properties.emptyObject"] : [];
      return { facts, labels };
    }
  }
  return { facts: [], labels: ["chat.jira.properties.valueUnknown"] };
}
function valueCard(source: Source): JiraAgileDetails {
  const path = source.path;
  const position: JiraAgileDetails = path === "" ? { facts: [], labels: ["chat.jira.properties.root"] }
    : typeof path === "string" && path.startsWith("/") && !/~(?![01])/u.test(path)
      ? { facts: [{ label: "chat.jira.properties.pointer", value: path }], labels: [] }
      : { facts: [], labels: ["chat.jira.properties.pathUnknown"] };
  const kind = typeof source.kind === "string" && Object.hasOwn(KINDS, source.kind) ? KINDS[source.kind] : undefined;
  const content = valueFacts(source);
  return { ...(content.body === undefined ? {} : { body: content.body }),
    facts: [...position.facts, ...content.facts],
    labels: [...position.labels, ...(kind === undefined ? [] : [kind]), ...content.labels] };
}

/** Already typed private values only: no JSON parsing, serialization, URL handling or state engine. */
export function jiraPropertyDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_PROPERTY_TOOLS.has(tool) || data.outcome === "failed") return [];
  const keys = JIRA_PROPERTY_KEY_TOOLS.has(tool);
  const items = Array.isArray(data.items) ? data.items.flatMap((value: unknown) => {
    const source = record(value);
    return source === undefined ? [] : [keys ? keyCard(source) : valueCard(source)];
  }) : [];
  return [header(tool, data), ...items];
}
