export const JIRA_FIELD_READ_MAX = 20;
export const JIRA_FIELD_ID_PATTERN = String.raw`^(?:[a-zA-Z][a-zA-Z0-9]*|customfield_\d{1,16})$`;
/** Bounded capability projection from current Jira create/edit/transition metadata (#4083). */
export const JIRA_FIELD_KINDS = [
  "text",
  "number",
  "date",
  "datetime",
  "user",
  "option",
  "strings",
  "users",
  "options",
  /** A single issue reference (`{ key }` or `{ id }`), e.g. the system `parent` field (#4176). */
  "issue",
  /** A field whose value shape Jira's metadata does not describe beyond its schema type; a bounded
   * JSON value is forwarded and Jira's own validation is authoritative (#4176). */
  "opaque",
  /** The system `issuelinks` field: links are added through a create/edit `links` argument. */
  "links",
  "unsupported",
] as const;
export type JiraFieldKind = (typeof JIRA_FIELD_KINDS)[number];
export const JIRA_MANAGED_READ_TOOLS = [
  "jira.global-issue-types",
  "jira.issue-type",
  "jira.issue-type-page",
  "jira.issue-type-alternatives",
  "jira.priorities",
  "jira.priority",
  "jira.priority-page",
  "jira.resolutions",
  "jira.resolution",
  "jira.resolution-page",
  "jira.statuses",
  "jira.status",
  "jira.status-page",
  "jira.status-categories",
  "jira.status-category",
  "jira.project-categories",
  "jira.project-category",
  "jira.project-statuses",
  "jira.project-types",
  "jira.project-type-definition",
  "jira.project-permission-scheme",
  "jira.project-issue-security-scheme",
  "jira.project-security-levels",
  "jira.project-workflow-scheme",
  "jira.project-priority-scheme",
  "jira.permission-schemes",
  "jira.permission-scheme",
  "jira.permission-grants",
  "jira.permission-grant",
  "jira.issue-security-schemes",
  "jira.issue-security-scheme",
  "jira.security-level",
  "jira.notification-schemes",
  "jira.notification-scheme",
  "jira.project-notification-scheme",
  "jira.user",
  "jira.users",
  "jira.user-directory",
  "jira.user-picker",
  "jira.group-members",
  "jira.groups",
  "jira.application-roles",
  "jira.application-role",
  "jira.issue-type-schemes",
  "jira.issue-type-scheme",
  "jira.issue-type-scheme-projects",
  "jira.workflow-scheme",
  "jira.workflow-scheme-default",
  "jira.workflow-scheme-draft",
  "jira.workflow-scheme-draft-default",
  "jira.workflow-scheme-issue-type",
  "jira.workflow-scheme-draft-issue-type",
  "jira.workflow-scheme-workflows",
  "jira.workflow-scheme-draft-workflows",
  "jira.screen-tabs",
  "jira.screen-tab-fields",
  "jira.screen-available-fields",
  "jira.projects",
  "jira.project",
  "jira.validate-project-key",
  "jira.project-permissions",
  "jira.project-type",
  "jira.components",
  "jira.component",
  "jira.versions",
  "jira.version",
  "jira.filter",
  "jira.favourite-filters",
  "jira.dashboards",
  "jira.dashboard",
  "jira.filter-share-scope",
  "jira.filter-permissions",
  "jira.filter-permission",
  "jira.boards",
  "jira.board",
  "jira.board-configuration",
  "jira.board-backlog",
  "jira.board-issues",
  "jira.board-epics",
  "jira.epic",
  "jira.epic-issues",
  "jira.sprints",
  "jira.sprint",
  "jira.sprint-issues",
  "jira.issue-types",
  "jira.create-fields",
  "jira.edit-fields",
  "jira.search",
  "jira.issue",
  "jira.comments",
  "jira.get-comment",
  "jira.link-types",
  "jira.issue-link",
  "jira.watchers",
  "jira.votes",
  "jira.worklogs",
  "jira.worklog",
  "jira.attachment-settings",
  "jira.attachment",
  "jira.attachment-archive",
  "jira.attachment-archive-summary",
  "jira.system-avatars",
  "jira.project-avatars",
  "jira.user-avatars",
  "jira.avatars",
  "jira.transitions",
  "jira.assignable-users",
  "jira.report",
  /** Appends a page of items to a server-held backlog draft; it changes nothing in Jira. */
  "jira.draft-stage",
] as const;
export type JiraManagedReadToolName = (typeof JIRA_MANAGED_READ_TOOLS)[number];
export type JiraFieldOperation = "set" | "add" | "remove";
export interface JiraFieldReference {
  readonly id?: string;
  readonly name?: string;
  readonly accountId?: string;
  /** Display only; never accepted as a mutation identity. */
  readonly label?: string;
}
export interface JiraFieldMetadata {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly hasDefaultValue: boolean;
  readonly kind: JiraFieldKind;
  readonly richText: boolean;
  readonly operations: readonly JiraFieldOperation[];
  readonly allowedValues?: readonly JiraFieldReference[];
  /** Jira's declared schema type (`string`, `array:string`, `any`, …) so a caller can shape an
   * opaque value; metadata only, never a mutation identity. */
  readonly schemaType?: string;
}
export interface JiraFieldUpdate {
  readonly fieldId: string;
  readonly operation: "add" | "remove";
  readonly value: string;
}
