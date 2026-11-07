import { deepFreeze } from "./deep-freeze.js";

/** Closed immutable read identities shared by native owners and the governed provider catalog. */
export const JIRA_READ_TOOL_FAMILIES = deepFreeze({
  applicationSettings: [
    "jira.application-properties", "jira.advanced-settings", "jira.my-preference",
  ],
  accountDiagnostics: [
    "jira.password-policy", "jira.duplicate-user-count", "jira.duplicate-users", "jira.search-error",
  ],
  issueContext: [
    "jira.issue-picker", "jira.pinned-comments", "jira.subtasks",
    "jira.subtask-move-availability", "jira.remote-links", "jira.remote-link",
  ],
  entityProperties: [
    "jira.board-property-keys", "jira.board-property", "jira.sprint-property-keys", "jira.sprint-property",
    "jira.comment-property-keys", "jira.comment-property", "jira.dashboard-item-property-keys", "jira.dashboard-item-property",
    "jira.issue-property-keys", "jira.issue-property", "jira.issue-type-property-keys", "jira.issue-type-property",
    "jira.project-property-keys", "jira.project-property", "jira.user-property-keys", "jira.user-property",
  ],
  jobObservations: [
    "jira.reindex-status", "jira.reindex-progress", "jira.reindex-request", "jira.reindex-requests",
    "jira.upgrade-result", "jira.index-snapshots", "jira.app-monitoring", "jira.ipd-monitoring", "jira.jmx-metrics",
  ],
  resourceLookups: [
    "jira.global-version-page", "jira.component-page", "jira.link-type", "jira.accessibility-settings",
  ],
  columns: ["jira.system-columns", "jira.user-columns", "jira.filter-columns"],
  maintenance: [
    "jira.cluster-nodes", "jira.cluster-upgrade-state", "jira.index-snapshot-status", "jira.index-summary",
  ],
  runtimeSettings: [
    "jira.jmx-metrics-exposed", "jira.search-max-aggregation-buckets", "jira.search-max-result-window",
  ],
  configuration: [
    "jira.screens", "jira.workflows", "jira.custom-fields", "jira.custom-field-options",
    "jira.terminology", "jira.terminology-entry", "jira.read-only-mode",
  ],
  jqlMetadata: ["jira.jql-autocomplete", "jira.jql-suggestions"],
  scopedDirectory: [
    "jira.multi-project-assignable-users",
    "jira.permission-users",
    "jira.browse-permission-users",
    "jira.group-user-picker",
    "jira.project-picker",
  ],
  fieldDirectory: ["jira.fields", "jira.custom-field-option"],
  release: [
    "jira.component-related-issue-counts",
    "jira.version-related-issue-counts",
    "jira.version-unresolved-issue-count",
    "jira.project-version-page",
  ],
  roles: [
    "jira.roles", "jira.role", "jira.role-default-actors", "jira.project-roles", "jira.project-role",
  ],
  prioritySchemes: ["jira.priority-schemes", "jira.priority-scheme"],
  instance: [
    "jira.server-info", "jira.instance-configuration", "jira.permission-definitions", "jira.myself",
  ],
  coreMetadata: [
    "jira.global-issue-types", "jira.issue-type", "jira.issue-type-page", "jira.issue-type-alternatives",
    "jira.priorities", "jira.priority", "jira.priority-page",
    "jira.resolutions", "jira.resolution", "jira.resolution-page",
    "jira.statuses", "jira.status", "jira.status-page", "jira.status-categories", "jira.status-category",
    "jira.project-categories", "jira.project-category", "jira.project-statuses",
    "jira.project-types", "jira.project-type-definition",
  ],
  projectAssociations: [
    "jira.project-permission-scheme", "jira.project-issue-security-scheme", "jira.project-security-levels",
    "jira.project-workflow-scheme", "jira.project-priority-scheme",
  ],
  accessSchemes: [
    "jira.permission-schemes", "jira.permission-scheme", "jira.permission-grants", "jira.permission-grant",
    "jira.issue-security-schemes", "jira.issue-security-scheme", "jira.security-level",
  ],
  notificationSchemes: [
    "jira.notification-schemes", "jira.notification-scheme", "jira.project-notification-scheme",
  ],
  users: ["jira.user", "jira.users", "jira.user-directory", "jira.user-picker"],
  directory: ["jira.group-members", "jira.groups", "jira.application-roles", "jira.application-role"],
  issueTypeSchemes: ["jira.issue-type-schemes", "jira.issue-type-scheme", "jira.issue-type-scheme-projects"],
  workflowSchemes: [
    "jira.workflow-scheme", "jira.workflow-scheme-default", "jira.workflow-scheme-draft",
    "jira.workflow-scheme-draft-default", "jira.workflow-scheme-issue-type",
    "jira.workflow-scheme-draft-issue-type", "jira.workflow-scheme-workflows", "jira.workflow-scheme-draft-workflows",
  ],
  screens: ["jira.screen-tabs", "jira.screen-tab-fields", "jira.screen-available-fields"],
  projectList: ["jira.projects"],
  projects: ["jira.project", "jira.validate-project-key", "jira.project-permissions", "jira.project-type"],
  components: ["jira.components", "jira.component"],
  versions: ["jira.versions", "jira.version"],
  filters: ["jira.filter", "jira.favourite-filters"],
  savedViews: [
    "jira.dashboards", "jira.dashboard", "jira.filter-share-scope", "jira.filter-permissions", "jira.filter-permission",
  ],
  agile: [
    "jira.boards", "jira.board", "jira.board-configuration", "jira.board-backlog", "jira.board-issues",
    "jira.board-epics", "jira.epic", "jira.epic-issues", "jira.sprints", "jira.sprint", "jira.sprint-issues",
  ],
  agileContext: [
    "jira.board-epicless-issues", "jira.board-epic-issues", "jira.board-projects",
    "jira.board-refined-velocity", "jira.board-sprint-issues", "jira.board-versions",
    "jira.epicless-issues", "jira.agile-issue", "jira.issue-estimation",
  ],
  issueMetadata: ["jira.issue-types", "jira.create-fields", "jira.edit-fields"],
  issues: ["jira.search", "jira.issue", "jira.comments"],
  comment: ["jira.get-comment"],
  issueLinks: ["jira.link-types", "jira.issue-link"],
  participation: ["jira.watchers", "jira.votes"],
  worklogs: ["jira.worklogs", "jira.worklog"],
  attachments: [
    "jira.attachment-settings", "jira.attachment", "jira.attachment-archive", "jira.attachment-archive-summary",
  ],
  avatars: ["jira.system-avatars", "jira.project-avatars", "jira.user-avatars", "jira.avatars"],
  issueWorkflow: ["jira.transitions", "jira.assignable-users"],
  // Staging changes only the existing server-held draft; it performs no Jira mutation.
  localCompositions: ["jira.report", "jira.draft-stage"],
} as const);
