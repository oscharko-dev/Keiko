/** Wire vocabulary of the deterministic Jira report (#4181, ADR-0128 D4). */

/** Export formats of a completed report. Both are produced by the server from the stored report. */
export const JIRA_REPORT_EXPORT_FORMATS = ["markdown", "csv"] as const;
export type JiraReportExportFormat = (typeof JIRA_REPORT_EXPORT_FORMATS)[number];

export const JIRA_REPORT_EXPORT_MEDIA_TYPES = {
  markdown: "text/markdown",
  csv: "text/csv",
} as const satisfies Record<JiraReportExportFormat, string>;

/** `reading`: more pages remain; `complete`: every issue of the scope was read; `incomplete`: the
 * read ended early for a closed reason and every number describes only the issues read. */
export const JIRA_REPORT_STATUSES = ["reading", "complete", "incomplete"] as const;
export type JiraReportStatus = (typeof JIRA_REPORT_STATUSES)[number];

export const JIRA_REPORT_INCOMPLETE_REASONS = [
  "read-failed",
  "scope-changed",
  "memory-budget",
  "issue-too-large",
  /** The issue template library cannot be read or holds a malformed template: the compliance
   * section was not evaluated, so a zero there would be a silent pass (#4177). */
  "template-unreadable",
] as const;
export type JiraReportIncompleteReason = (typeof JIRA_REPORT_INCOMPLETE_REASONS)[number];

/** Pageable lists of a completed report. `summary` is the bounded default projection. */
export const JIRA_REPORT_SECTIONS = [
  "summary",
  "statuses",
  "epics",
  "deviations",
  "orphans",
  "uncovered",
  "requirements",
  "comment",
] as const;
export type JiraReportSection = (typeof JIRA_REPORT_SECTIONS)[number];

/** Status categories as Jira defines them; the report never names a customer status. */
export const JIRA_REPORT_STATUS_CATEGORIES = ["new", "indeterminate", "done", "undefined"] as const;
export type JiraReportStatusCategory = (typeof JIRA_REPORT_STATUS_CATEGORIES)[number];

/** The one rule id the report itself raises; a template checker contributes its own stable ids. */
export const JIRA_REPORT_REQUIRED_FIELD_RULE = "required-field-empty";

export const JIRA_REPORT_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export const JIRA_REPORT_REQUIREMENT_ID_MAX = 1000;
export const JIRA_REPORT_REQUIREMENT_ID_CHARS_MAX = 64;
/** Time spent reading Jira in one tool call; the report continues in the next call. */
export const JIRA_REPORT_READ_SLICE_MS = 15_000;

/** Body of the browser download; the server returns the exact file text it produced. */
export interface JiraReportExportResponse {
  readonly format: JiraReportExportFormat;
  readonly fileName: string;
  readonly mediaType: (typeof JIRA_REPORT_EXPORT_MEDIA_TYPES)[JiraReportExportFormat];
  readonly content: string;
  readonly byteCount: number;
  readonly reportDigest: string;
}
