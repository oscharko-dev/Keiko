import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";

/** Built-in fields have product wording even when no metadata read preceded an approval. */
const STANDARD_FIELD_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  summary: "chat.jira.field.summary",
  description: "chat.jira.field.description",
  environment: "chat.jira.field.environment",
  labels: "chat.jira.field.labels",
  priority: "chat.jira.field.priority",
  assignee: "chat.jira.fact.assignee",
  reporter: "chat.jira.field.reporter",
  duedate: "chat.jira.field.dueDate",
  components: "chat.jira.field.components",
  versions: "chat.jira.field.affectedVersions",
  fixVersions: "chat.jira.field.fixVersions",
  project: "chat.jira.fact.project",
  issuetype: "chat.jira.fact.issueType",
  status: "chat.jira.field.status",
  resolution: "chat.jira.field.resolution",
  timetracking: "chat.jira.field.timeTracking",
  security: "chat.jira.field.security",
  parent: "chat.jira.field.parent",
  attachment: "chat.jira.field.attachments",
};

export function jiraStandardFieldLabel(id: string, t: OptionalWidgetTranslate): string | undefined {
  const key = Object.hasOwn(STANDARD_FIELD_LABELS, id) ? STANDARD_FIELD_LABELS[id] : undefined;
  return key === undefined ? undefined : t(key);
}
